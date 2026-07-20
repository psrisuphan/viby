// =============================================================================
// commands/library.rs — Tauri commands for music library management
// =============================================================================
//
// These commands handle:
//   - Adding/removing library folders
//   - Scanning folders for audio files
//   - Browsing tracks, albums, artists, genres
//   - Searching the library
//   - Getting track artwork
// =============================================================================

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::ArtworkCache;
use crate::NormalizationAnalysisLock;
use crate::ScanLock;
use crate::error::AppError;
use crate::library::database::Database;
use crate::library::metadata;
use crate::library::scanner;
use crate::models::{Album, Artist, SearchResults, TopArtist, Track};
use image::ImageFormat;
use image::{ImageReader, Limits};

// =============================================================================
// Library folder management
// =============================================================================

/// Add a music folder to the library.
/// The folder will be scanned for audio files.
///
/// Frontend: `invoke('add_library_folder', { path: '/Users/me/Music' })`
#[tauri::command]
pub fn add_library_folder(path: String, db: State<'_, Mutex<Database>>) -> Result<(), AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.add_library_folder(&path).map_err(AppError::from)?;
    Ok(())
}

/// Remove a music folder from the library.
///
/// Frontend: `invoke('remove_library_folder', { path: '/Users/me/Music' })`
#[tauri::command]
pub fn remove_library_folder(path: String, db: State<'_, Mutex<Database>>) -> Result<(), AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.remove_library_folder(&path).map_err(AppError::from)?;
    Ok(())
}

/// Get all registered library folder paths.
///
/// Frontend: `const folders = await invoke('get_library_folders')`
#[tauri::command]
pub fn get_library_folders(db: State<'_, Mutex<Database>>) -> Result<Vec<String>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_library_folders().map_err(AppError::from)
}

// =============================================================================
// Library scanning
// =============================================================================

fn scan_worker_count(available_parallelism: usize) -> usize {
    available_parallelism.clamp(1, 4)
}

/// Scan all registered library folders for audio files.
/// This is a potentially long-running operation — progress events are emitted.
///
/// Frontend: `invoke('scan_library')`
///
/// Events emitted:
///   - `scan-progress`: { total: number, current: number, file: string }
///   - `scan-complete`: { total_tracks: number, new_tracks: number }
///
/// The scan:
///   1. Gets all registered library folders
///   2. Walks each folder recursively for audio files
///   3. Extracts metadata from each file
///   4. Stores/updates tracks in the database
///   5. Removes tracks whose files no longer exist
#[tauri::command]
pub async fn scan_library(
    app: AppHandle,
    db: State<'_, Mutex<Database>>,
    scan_lock: State<'_, ScanLock>,
) -> Result<serde_json::Value, AppError> {
    // Prevent concurrent scans. ScanGuard releases the lock on drop.
    struct ScanGuard<'a>(&'a ScanLock);
    impl Drop for ScanGuard<'_> {
        fn drop(&mut self) {
            self.0.release();
        }
    }

    if !scan_lock.try_acquire() {
        return Err(AppError::ScanBusy);
    }
    let _guard = ScanGuard(&scan_lock);

    let folders = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        db.get_library_folders().map_err(AppError::from)?
    };

    if folders.is_empty() {
        return Ok(serde_json::json!({
            "total_tracks": 0,
            "new_tracks": 0,
            "message": "No library folders configured. Add a folder first."
        }));
    }

    // Phase 1: Discover all audio files
    let mut all_files: Vec<String> = Vec::new();
    for folder in &folders {
        all_files.extend(scanner::scan_directory(folder));
    }
    let total_files = all_files.len();

    // Pre-load existing file fingerprints so changed files are refreshed too.
    let existing_by_path: HashMap<String, crate::library::database::TrackFingerprint> = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        db.get_track_fingerprints()
            .map_err(AppError::from)?
            .into_iter()
            .map(|fingerprint| (fingerprint.file_path.clone(), fingerprint))
            .collect()
    };

    #[derive(Clone)]
    struct ScanCandidate {
        path: String,
        id: String,
        date_added: String,
        is_changed: bool,
    }

    let date_added = crate::utils::current_timestamp();
    let mut candidates = Vec::new();
    for file_path in all_files {
        let file_meta = std::fs::metadata(&file_path).ok();
        let file_size = file_meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
        let file_modified_unix = file_meta
            .and_then(|m| m.modified().ok())
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64);

        match existing_by_path.get(&file_path) {
            Some(existing)
                if existing.file_size == file_size
                    && existing.file_modified_unix == file_modified_unix => {}
            Some(existing) => candidates.push(ScanCandidate {
                path: file_path,
                id: existing.id.clone(),
                date_added: existing.date_added.clone(),
                is_changed: true,
            }),
            None => candidates.push(ScanCandidate {
                path: file_path,
                id: uuid::Uuid::new_v4().to_string(),
                date_added: date_added.clone(),
                is_changed: false,
            }),
        }
    }

    let candidate_count = candidates.len();

    // Phase 2: Extract metadata for new and changed files in parallel.
    // tokio::spawn_blocking offloads each blocking file read onto the thread pool
    // so pending files are processed concurrently instead of one at a time.
    let skipped_count = total_files.saturating_sub(candidate_count);

    let _ = app.emit(
        "scan-progress",
        serde_json::json!({
            "total_files": total_files,
            "processed_files": skipped_count,
            "current_file": "",
            "status": "scanning",
        }),
    );

    let worker_count = scan_worker_count(
        std::thread::available_parallelism()
            .map(|count| count.get())
            .unwrap_or(2),
    );
    let mut results = Vec::with_capacity(candidate_count);
    for chunk in candidates.chunks(worker_count) {
        let tasks: Vec<_> = chunk
            .iter()
            .cloned()
            .map(|candidate| {
                tokio::task::spawn_blocking(move || {
                    metadata::extract_metadata_no_artwork(&candidate.path)
                        .map(|meta| (candidate, meta))
                })
            })
            .collect();
        for task in tasks {
            results.push(task.await);
        }
    }

    let mut upsert_tracks: Vec<Track> = Vec::new();
    let mut new_count = 0usize;
    let mut changed_count = 0usize;
    for (i, res) in results.into_iter().enumerate() {
        // Emit progress every 50 completions to avoid IPC thundering-herd
        if i == 0 || (i + 1) % 50 == 0 || i + 1 == candidate_count {
            let _ = app.emit(
                "scan-progress",
                serde_json::json!({
                    "total_files": total_files,
                    "processed_files": skipped_count + i + 1,
                    "current_file": "",
                    "status": "scanning",
                }),
            );
        }

        let Ok(Ok((candidate, meta))) = res else {
            continue;
        };
        if candidate.is_changed {
            changed_count += 1;
        } else {
            new_count += 1;
        }

        upsert_tracks.push(Track {
            id: candidate.id,
            title: meta.title,
            artist: meta.artist,
            album: meta.album,
            album_artist: meta.album_artist,
            genre: meta.genre,
            year: meta.year,
            track_number: meta.track_number,
            disc_number: meta.disc_number,
            duration_secs: meta.duration_secs,
            file_path: meta.file_path,
            file_size: meta.file_size,
            replaygain_track_gain: meta.replaygain_track_gain,
            replaygain_track_peak: meta.replaygain_track_peak,
            normalization_source: meta.normalization_source,
            file_modified_unix: meta.file_modified_unix,
            date_added: candidate.date_added,
        });
    }

    // Phase 3: Batch-insert all new/changed tracks in a single transaction
    if !upsert_tracks.is_empty() {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        db.upsert_tracks_batch(&upsert_tracks)
            .map_err(AppError::from)?;
    }

    // Phase 4: Remove tracks whose files no longer exist
    let removed = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        db.remove_missing_tracks().unwrap_or(0)
    };

    let result = serde_json::json!({
        "total_files": total_files,
        "new_tracks": new_count,
        "changed_tracks": changed_count,
        "removed_tracks": removed,
    });

    let _ = app.emit(
        "scan-progress",
        serde_json::json!({
            "total_files": total_files,
            "processed_files": total_files,
            "current_file": "",
            "status": "complete",
            "new_tracks": new_count,
            "changed_tracks": changed_count,
            "removed_tracks": removed,
        }),
    );
    let _ = app.emit("scan-complete", &result);

    Ok(result)
}

#[tauri::command]
pub fn analyze_missing_normalization(
    app: AppHandle,
    analysis_lock: State<'_, NormalizationAnalysisLock>,
) -> Result<serde_json::Value, AppError> {
    if !analysis_lock.try_acquire() {
        return Ok(serde_json::json!({
            "started": false,
            "message": "Normalization analysis is already running."
        }));
    }

    let task_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let release_lock = || {
            if let Some(lock) = task_app.try_state::<NormalizationAnalysisLock>() {
                lock.release();
            }
        };

        let tracks = match task_app.try_state::<Mutex<Database>>() {
            Some(db) => match db.lock() {
                Ok(db) => db.get_tracks_missing_normalization().unwrap_or_default(),
                Err(err) => {
                    eprintln!("[Normalization] Failed to lock database: {err}");
                    release_lock();
                    return;
                }
            },
            None => {
                release_lock();
                return;
            }
        };

        let total = tracks.len();
        let mut analyzed = 0usize;
        let mut skipped = 0usize;
        let mut failed = 0usize;
        let _ = task_app.emit(
            "normalization-progress",
            serde_json::json!({
                "analyzed": analyzed,
                "total": total,
                "skipped": skipped,
                "failed": failed,
            }),
        );

        for track in tracks {
            let path = track.file_path.clone();
            let track_id = track.id.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                crate::audio::normalization::analyze_file(&path)
            })
            .await;

            match result {
                Ok(Ok(Some(analysis))) => {
                    if let Some(db) = task_app.try_state::<Mutex<Database>>() {
                        match db.lock() {
                            Ok(db) => {
                                if db
                                    .update_track_normalization(
                                        &track_id,
                                        analysis.gain_db,
                                        analysis.peak,
                                        "analysis",
                                    )
                                    .is_ok()
                                {
                                    analyzed += 1;
                                } else {
                                    failed += 1;
                                }
                            }
                            Err(_) => failed += 1,
                        }
                    } else {
                        failed += 1;
                    }
                }
                Ok(Ok(None)) => skipped += 1,
                Ok(Err(err)) => {
                    failed += 1;
                    eprintln!("[Normalization] {err}");
                }
                Err(err) => {
                    failed += 1;
                    eprintln!("[Normalization] Analysis task failed: {err}");
                }
            }

            let processed = analyzed + skipped + failed;
            if processed == total || processed.is_multiple_of(10) {
                let _ = task_app.emit(
                    "normalization-progress",
                    serde_json::json!({
                        "analyzed": analyzed,
                        "total": total,
                        "skipped": skipped,
                        "failed": failed,
                    }),
                );
            }
        }

        release_lock();
    });

    Ok(serde_json::json!({ "started": true }))
}

// =============================================================================
// Library browsing
// =============================================================================

/// Get all tracks in the library.
///
/// Frontend: `const tracks = await invoke('get_all_tracks')`
#[tauri::command]
pub fn get_all_tracks(db: State<'_, Mutex<Database>>) -> Result<Vec<Track>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_all_tracks().map_err(AppError::from)
}

/// Get all tracks for a specific album, sorted by disc then track number.
/// Avoids filtering all tracks on the frontend for large libraries.
///
/// Frontend: `const tracks = await invoke('get_album_tracks', { album, albumArtist })`
#[tauri::command]
pub fn get_album_tracks(
    album: String,
    album_artist: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<Track>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_tracks_by_album_and_artist(&album, &album_artist)
        .map_err(AppError::from)
}

/// Get all albums in the library.
///
/// Frontend: `const albums = await invoke('get_albums')`
#[tauri::command]
pub fn get_albums(db: State<'_, Mutex<Database>>) -> Result<Vec<Album>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_albums().map_err(AppError::from)
}

/// Get all artists in the library.
///
/// Frontend: `const artists = await invoke('get_artists')`
#[tauri::command]
pub fn get_artists(db: State<'_, Mutex<Database>>) -> Result<Vec<Artist>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_artists().map_err(AppError::from)
}

/// Get all genre names in the library.
///
/// Frontend: `const genres = await invoke('get_genres')`
#[tauri::command]
pub fn get_genres(db: State<'_, Mutex<Database>>) -> Result<Vec<String>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_genres().map_err(AppError::from)
}

/// Search across tracks, albums, and artists.
///
/// Frontend: `const results = await invoke('search', { query: 'beatles' })`
///
/// Returns a SearchResults object with matching tracks, albums, and artists.
#[tauri::command]
pub fn search(query: String, db: State<'_, Mutex<Database>>) -> Result<SearchResults, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;

    // Search tracks
    let tracks = db.search_tracks(&query).map_err(AppError::from)?;

    // Derive matching albums from the found tracks, counting tracks per album
    let mut album_map: std::collections::HashMap<String, Album> = std::collections::HashMap::new();
    for track in &tracks {
        let key = format!("{}|{}", track.album, track.album_artist);
        let entry = album_map.entry(key).or_insert_with(|| Album {
            name: track.album.clone(),
            artist: track.album_artist.clone(),
            year: track.year,
            track_count: 0,
            artwork_track_id: Some(track.id.clone()),
        });
        entry.track_count += 1;
    }
    let mut albums: Vec<Album> = album_map.into_values().collect();
    albums.sort_by_key(|a| a.name.to_lowercase());

    // Derive matching artists, counting tracks and unique albums per artist
    struct ArtistAcc {
        track_count: u32,
        albums: std::collections::HashSet<String>,
    }
    let mut artist_map: std::collections::HashMap<String, ArtistAcc> =
        std::collections::HashMap::new();
    for track in &tracks {
        let acc = artist_map
            .entry(track.artist.clone())
            .or_insert_with(|| ArtistAcc {
                track_count: 0,
                albums: std::collections::HashSet::new(),
            });
        acc.track_count += 1;
        acc.albums.insert(track.album.clone());
    }
    let mut artists: Vec<Artist> = artist_map
        .into_iter()
        .map(|(name, acc)| Artist {
            name,
            album_count: acc.albums.len() as u32,
            track_count: acc.track_count,
        })
        .collect();
    artists.sort_by_key(|a| a.name.to_lowercase());

    Ok(SearchResults {
        tracks,
        albums,
        artists,
    })
}

/// Artwork returned to the frontend: base64-encoded image data plus its MIME type.
#[derive(serde::Serialize)]
pub struct ArtworkPayload {
    pub data: String,
    pub mime_type: String,
}

/// Get the embedded artwork for a track.
/// Helper to get the embedded or folder artwork bytes for a track (cached).
pub fn fetch_raw_artwork(
    track_id: &str,
    db: &Mutex<Database>,
    artwork_cache: &Mutex<ArtworkCache>,
) -> Result<Option<(Vec<u8>, String)>, AppError> {
    // Look up the track to get its album identity and file path.
    let track = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        match db.get_track(track_id).map_err(AppError::from)? {
            Some(t) => t,
            None => return Ok(None),
        }
    };

    // Cache key is (album, album_artist) so all tracks on the same album share
    // one entry — avoids storing N identical copies of the same cover image.
    let album_key = format!("{}||{}", track.album, track.album_artist);

    let raw_cache_key = format!("raw:{album_key}");
    if let Ok(cache) = artwork_cache.lock()
        && let Some(entry) = cache.get(&raw_cache_key)
    {
        return Ok(entry);
    }

    let meta = match metadata::extract_metadata(&track.file_path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };

    // Try embedded artwork first, then fall back to common folder image files.
    let artwork_bytes = meta.artwork.or_else(|| {
        let path = std::path::Path::new(&track.file_path);
        if let Some(parent) = path.parent() {
            let common_names = [
                "cover.jpg",
                "cover.jpeg",
                "cover.png",
                "folder.jpg",
                "folder.jpeg",
                "folder.png",
                "front.jpg",
                "front.jpeg",
                "front.png",
                "Artwork.jpg",
                "Artwork.jpeg",
                "Artwork.png",
            ];
            for entry in std::fs::read_dir(parent).ok()?.flatten() {
                if let Ok(file_type) = entry.file_type()
                    && file_type.is_file()
                    && let Some(file_name) = entry.file_name().to_str()
                {
                    let file_name_lower = file_name.to_lowercase();
                    if common_names
                        .iter()
                        .any(|name| file_name_lower == name.to_lowercase())
                        && let Ok(bytes) = read_bounded_artwork(&entry.path())
                    {
                        return Some(bytes);
                    }
                }
            }
        }
        None
    });

    let result = match artwork_bytes {
        Some(bytes) => {
            let mime_type = detect_image_mime(&bytes);
            Some((bytes, mime_type))
        }
        None => None,
    };

    if let Ok(mut cache) = artwork_cache.lock() {
        cache.insert(raw_cache_key, result.clone());
    }

    Ok(result)
}

pub const THUMBNAIL_ARTWORK_SIZE: u32 = 128;
pub const STANDARD_ARTWORK_SIZE: u32 = 384;
pub const FULLSCREEN_ARTWORK_SIZE: u32 = 768;

pub fn artwork_size_from_query(query: Option<&str>) -> u32 {
    query
        .and_then(|query| {
            query.split('&').find_map(|pair| {
                let (key, value) = pair.split_once('=')?;
                (key == "size").then(|| value.parse::<u32>().ok()).flatten()
            })
        })
        .filter(|size| {
            matches!(
                size,
                &THUMBNAIL_ARTWORK_SIZE | &STANDARD_ARTWORK_SIZE | &FULLSCREEN_ARTWORK_SIZE
            )
        })
        .unwrap_or(STANDARD_ARTWORK_SIZE)
}

fn resize_artwork(bytes: &[u8], max_edge: u32) -> Option<(Vec<u8>, String)> {
    if bytes.len() > metadata::MAX_ARTWORK_BYTES {
        return None;
    }
    let format = image::guess_format(bytes).ok()?;
    let mut reader = ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?;
    if image.width() <= max_edge && image.height() <= max_edge {
        return Some((bytes.to_vec(), detect_image_mime(bytes)));
    }

    let resized = image.thumbnail(max_edge, max_edge);
    let output_format = match format {
        ImageFormat::Jpeg => ImageFormat::Jpeg,
        ImageFormat::Gif => ImageFormat::Gif,
        ImageFormat::WebP => ImageFormat::WebP,
        _ => ImageFormat::Png,
    };
    let mut output = std::io::Cursor::new(Vec::new());
    resized.write_to(&mut output, output_format).ok()?;
    let mime = match output_format {
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::Gif => "image/gif",
        ImageFormat::WebP => "image/webp",
        _ => "image/png",
    };
    Some((output.into_inner(), mime.to_string()))
}

fn read_bounded_artwork(path: &std::path::Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;

    let file = std::fs::File::open(path)?;
    if file.metadata()?.len() > metadata::MAX_ARTWORK_BYTES as u64 {
        return Err(std::io::Error::other("artwork exceeds size limit"));
    }
    let mut bytes = Vec::new();
    file.take(metadata::MAX_ARTWORK_BYTES as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > metadata::MAX_ARTWORK_BYTES {
        return Err(std::io::Error::other("artwork exceeds size limit"));
    }
    Ok(bytes)
}

pub fn fetch_sized_artwork(
    track_id: &str,
    size: u32,
    db: &Mutex<Database>,
    artwork_cache: &Mutex<ArtworkCache>,
) -> Result<Option<(Vec<u8>, String)>, AppError> {
    let album_key = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let Some(track) = db.get_track(track_id).map_err(AppError::from)? else {
            return Ok(None);
        };
        format!("{}||{}", track.album, track.album_artist)
    };
    let cache_key = format!("sized:{album_key}:{size}");
    if let Ok(cache) = artwork_cache.lock()
        && let Some(entry) = cache.get(&cache_key)
    {
        return Ok(entry);
    }

    let raw = fetch_raw_artwork(track_id, db, artwork_cache)?;
    let result = raw.map(|(bytes, mime)| resize_artwork(&bytes, size).unwrap_or((bytes, mime)));
    if let Ok(mut cache) = artwork_cache.lock() {
        cache.insert(cache_key, result.clone());
    }
    Ok(result)
}

/// Get the embedded artwork for a track.
///
/// Frontend: `const artwork = await invoke('get_track_artwork', { trackId: '...' })`
///
/// Returns `{ data, mime_type }` or null. The frontend builds the data URL as:
/// `data:${mime_type};base64,${data}`
#[tauri::command]
pub fn get_track_artwork(
    track_id: String,
    size: Option<u32>,
    db: State<'_, Mutex<Database>>,
    artwork_cache: State<'_, Mutex<ArtworkCache>>,
) -> Result<Option<ArtworkPayload>, AppError> {
    let size = size
        .filter(|size| {
            matches!(
                size,
                &THUMBNAIL_ARTWORK_SIZE | &STANDARD_ARTWORK_SIZE | &FULLSCREEN_ARTWORK_SIZE
            )
        })
        .unwrap_or(STANDARD_ARTWORK_SIZE);
    let raw = fetch_sized_artwork(&track_id, size, &db, &artwork_cache)?;
    Ok(raw.map(|(bytes, mime_type)| ArtworkPayload {
        data: base64_encode(&bytes),
        mime_type,
    }))
}

#[tauri::command]
pub fn clear_artwork_cache(artwork_cache: State<'_, Mutex<ArtworkCache>>) -> Result<(), AppError> {
    let mut cache = artwork_cache
        .lock()
        .map_err(|e| AppError::Other(e.to_string()))?;
    cache.clear();
    Ok(())
}

/// Detect the MIME type of image bytes from their magic number header.
fn detect_image_mime(bytes: &[u8]) -> String {
    if bytes.starts_with(b"\x89PNG") {
        "image/png".to_string()
    } else if bytes.starts_with(b"\xff\xd8\xff") {
        "image/jpeg".to_string()
    } else if bytes.starts_with(b"GIF") {
        "image/gif".to_string()
    } else if bytes.starts_with(b"WEBP") || (bytes.len() > 12 && &bytes[8..12] == b"WEBP") {
        "image/webp".to_string()
    } else {
        "image/jpeg".to_string()
    }
}

/// Simple base64 encoding (to avoid adding a crate dependency).
/// Encodes a byte slice into a base64 String.
fn base64_encode(data: &[u8]) -> String {
    const CHARS: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut result = String::with_capacity(data.len().div_ceil(3) * 4);
    let chunks = data.chunks(3);

    for chunk in chunks {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };

        let triple = (b0 << 16) | (b1 << 8) | b2;

        result.push(CHARS[((triple >> 18) & 0x3F) as usize] as char);
        result.push(CHARS[((triple >> 12) & 0x3F) as usize] as char);

        if chunk.len() > 1 {
            result.push(CHARS[((triple >> 6) & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }

        if chunk.len() > 2 {
            result.push(CHARS[(triple & 0x3F) as usize] as char);
        } else {
            result.push('=');
        }
    }

    result
}

// =============================================================================
// Play history commands
// =============================================================================

#[tauri::command]
pub fn clear_play_history(db: State<'_, Mutex<Database>>) -> Result<(), AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.clear_play_history().map_err(AppError::from)
}

#[tauri::command]
pub fn get_recently_played(db: State<'_, Mutex<Database>>) -> Result<Vec<Track>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_recently_played(20).map_err(AppError::from)
}

#[tauri::command]
pub fn get_top_artists_played(db: State<'_, Mutex<Database>>) -> Result<Vec<TopArtist>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_top_artists_played(8).map_err(AppError::from)
}

#[tauri::command]
pub fn get_recently_added_tracks(db: State<'_, Mutex<Database>>) -> Result<Vec<Track>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_recently_added_tracks(20).map_err(AppError::from)
}

#[cfg(test)]
mod tests {
    use super::{
        FULLSCREEN_ARTWORK_SIZE, STANDARD_ARTWORK_SIZE, THUMBNAIL_ARTWORK_SIZE,
        artwork_size_from_query, read_bounded_artwork, resize_artwork, scan_worker_count,
    };
    use image::{DynamicImage, ImageFormat};
    use std::io::Cursor;

    #[test]
    fn scan_workers_are_bounded() {
        assert_eq!(scan_worker_count(1), 1);
        assert_eq!(scan_worker_count(8), 4);
    }

    #[test]
    fn artwork_size_query_accepts_only_supported_sizes() {
        assert_eq!(artwork_size_from_query(None), STANDARD_ARTWORK_SIZE);
        assert_eq!(
            artwork_size_from_query(Some("size=128")),
            THUMBNAIL_ARTWORK_SIZE
        );
        assert_eq!(
            artwork_size_from_query(Some("size=768")),
            FULLSCREEN_ARTWORK_SIZE
        );
        assert_eq!(
            artwork_size_from_query(Some("size=7001")),
            STANDARD_ARTWORK_SIZE
        );
    }

    #[test]
    fn artwork_resize_bounds_longest_edge_without_upscaling() {
        let mut source = Cursor::new(Vec::new());
        DynamicImage::new_rgb8(800, 400)
            .write_to(&mut source, ImageFormat::Png)
            .unwrap();
        let source = source.into_inner();

        let (resized, mime) = resize_artwork(&source, STANDARD_ARTWORK_SIZE).unwrap();
        let resized = image::load_from_memory(&resized).unwrap();
        assert_eq!((resized.width(), resized.height()), (384, 192));
        assert_eq!(mime, "image/png");

        let (unchanged, _) = resize_artwork(&source, 1024).unwrap();
        assert_eq!(unchanged, source);
    }

    #[test]
    fn artwork_reader_rejects_oversized_files() {
        let path =
            std::env::temp_dir().join(format!("viby-artwork-limit-{}.jpg", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(crate::library::metadata::MAX_ARTWORK_BYTES as u64 + 1)
            .unwrap();

        assert!(read_bounded_artwork(&path).is_err());
        std::fs::remove_file(path).unwrap();
    }
}
