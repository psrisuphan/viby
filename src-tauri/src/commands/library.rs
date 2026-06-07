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

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::ArtworkCache;
use crate::ScanLock;
use crate::error::AppError;
use crate::library::database::Database;
use crate::library::metadata;
use crate::library::scanner;
use crate::models::{Album, Artist, SearchResults, TopArtist, Track};

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

    // Pre-load existing paths so the loop needs no DB read per file
    let existing_paths: std::collections::HashSet<String> = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        db.get_all_file_paths()
            .map_err(AppError::from)?
            .into_iter()
            .collect()
    };

    // Phase 2: Filter to new files only, then extract metadata in parallel.
    // tokio::spawn_blocking offloads each blocking file read onto the thread pool
    // so all new files are processed concurrently instead of one at a time.
    let new_files: Vec<String> = all_files
        .into_iter()
        .filter(|p| !existing_paths.contains(p))
        .collect();
    let new_file_count = new_files.len();

    let _ = app.emit(
        "scan-progress",
        serde_json::json!({
            "total_files": total_files,
            "processed_files": total_files - new_file_count,
            "current_file": "",
            "status": "scanning",
        }),
    );

    let tasks: Vec<_> = new_files
        .into_iter()
        .map(|file_path| {
            tokio::task::spawn_blocking(move || {
                metadata::extract_metadata_no_artwork(&file_path).map(|meta| (file_path, meta))
            })
        })
        .collect();

    let date_added = crate::utils::current_timestamp();
    let results = futures::future::join_all(tasks).await;

    let mut new_tracks: Vec<Track> = Vec::new();
    for (i, res) in results.into_iter().enumerate() {
        // Emit progress every 50 completions to avoid IPC thundering-herd
        if i == 0 || (i + 1) % 50 == 0 || i + 1 == new_file_count {
            let _ = app.emit(
                "scan-progress",
                serde_json::json!({
                    "total_files": total_files,
                    "processed_files": (total_files - new_file_count) + i + 1,
                    "current_file": "",
                    "status": "scanning",
                }),
            );
        }

        let Ok(Ok((_, meta))) = res else { continue };
        new_tracks.push(Track {
            id: uuid::Uuid::new_v4().to_string(),
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
            date_added: date_added.clone(),
        });
    }

    let new_count = new_tracks.len();

    // Phase 3: Batch-insert all new tracks in a single transaction
    if !new_tracks.is_empty() {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        db.upsert_tracks_batch(&new_tracks)
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
            "removed_tracks": removed,
        }),
    );
    let _ = app.emit("scan-complete", &result);

    Ok(result)
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
///
/// Frontend: `const artwork = await invoke('get_track_artwork', { trackId: '...' })`
///
/// Returns `{ data, mime_type }` or null. The frontend builds the data URL as:
/// `data:${mime_type};base64,${data}`
#[tauri::command]
pub fn get_track_artwork(
    track_id: String,
    db: State<'_, Mutex<Database>>,
    artwork_cache: State<'_, Mutex<ArtworkCache>>,
) -> Result<Option<ArtworkPayload>, AppError> {
    // Look up the track to get its album identity and file path.
    let track = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        match db.get_track(&track_id).map_err(AppError::from)? {
            Some(t) => t,
            None => return Ok(None),
        }
    };

    // Cache key is (album, album_artist) so all tracks on the same album share
    // one entry — avoids storing N identical copies of the same cover image.
    let album_key = format!("{}||{}", track.album, track.album_artist);

    if let Ok(cache) = artwork_cache.lock()
        && let Some(entry) = cache.entries.get(&album_key)
    {
        return Ok(entry.as_ref().map(|(data, mime)| ArtworkPayload {
            data: data.clone(),
            mime_type: mime.clone(),
        }));
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
                        && let Ok(bytes) = std::fs::read(entry.path())
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
            Some((base64_encode(&bytes), mime_type))
        }
        None => None,
    };

    // Populate cache with insertion-order FIFO eviction.
    if let Ok(mut cache) = artwork_cache.lock() {
        if !cache.entries.contains_key(&album_key) {
            if cache.entries.len() >= cache.max_size
                && let Some(oldest) = cache.order.pop_front()
            {
                cache.entries.remove(&oldest);
            }
            cache.order.push_back(album_key.clone());
        }
        cache.entries.insert(album_key, result.clone());
    }

    Ok(result.map(|(data, mime_type)| ArtworkPayload { data, mime_type }))
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
