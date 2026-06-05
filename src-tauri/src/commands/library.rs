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

use crate::library::database::Database;
use crate::library::metadata;
use crate::library::scanner;
use crate::models::{Album, Artist, SearchResults, Track};

// =============================================================================
// Library folder management
// =============================================================================

/// Add a music folder to the library.
/// The folder will be scanned for audio files.
///
/// Frontend: `invoke('add_library_folder', { path: '/Users/me/Music' })`
#[tauri::command]
pub fn add_library_folder(
    path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.add_library_folder(&path)
        .map_err(|e| format!("Failed to add folder: {}", e))?;
    Ok(())
}

/// Remove a music folder from the library.
///
/// Frontend: `invoke('remove_library_folder', { path: '/Users/me/Music' })`
#[tauri::command]
pub fn remove_library_folder(
    path: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.remove_library_folder(&path)
        .map_err(|e| format!("Failed to remove folder: {}", e))?;
    Ok(())
}

/// Get all registered library folder paths.
///
/// Frontend: `const folders = await invoke('get_library_folders')`
#[tauri::command]
pub fn get_library_folders(db: State<'_, Mutex<Database>>) -> Result<Vec<String>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_library_folders()
        .map_err(|e| format!("Failed to get folders: {}", e))
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
) -> Result<serde_json::Value, String> {
    // Get all library folders
    let folders = {
        let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
        db.get_library_folders()
            .map_err(|e| format!("Failed to get folders: {}", e))?
    };

    if folders.is_empty() {
        return Ok(serde_json::json!({
            "total_tracks": 0,
            "new_tracks": 0,
            "message": "No library folders configured. Add a folder first."
        }));
    }

    // Phase 1: Discover all audio files across all folders
    let mut all_files: Vec<String> = Vec::new();
    for folder in &folders {
        let files = scanner::scan_directory(folder);
        all_files.extend(files);
    }

    let total_files = all_files.len();
    let mut new_tracks = 0;

    // Load all already-indexed file paths upfront so the per-file loop only needs
    // one DB lock per new track (instead of two per file for the check + insert).
    let existing_paths: std::collections::HashSet<String> = {
        let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
        db.get_all_file_paths()
            .map_err(|e| format!("Failed to load existing paths: {}", e))?
            .into_iter()
            .collect()
    };

    // Phase 2: Extract metadata and store in database
    for (index, file_path) in all_files.iter().enumerate() {
        // Emit progress event so the UI can show a progress bar
        let _ = app.emit(
            "scan-progress",
            serde_json::json!({
                "total_files": total_files,
                "processed_files": index + 1,
                "current_file": file_path,
                "status": "scanning",
            }),
        );

        if existing_paths.contains(file_path) {
            continue; // Skip files we've already indexed
        }

        // Extract metadata from the audio file
        let meta = match metadata::extract_metadata(file_path) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[Scanner] Failed to read metadata for '{}': {}", file_path, e);
                continue; // Skip files with unreadable metadata
            }
        };

        // Create a Track and store it in the database
        let track = Track {
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
            date_added: crate::utils::current_timestamp(),
        };

        let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
        if let Err(e) = db.upsert_track(&track) {
            eprintln!("[Scanner] Failed to store track '{}': {}", track.title, e);
            continue;
        }

        new_tracks += 1;
    }

    // Phase 3: Remove tracks whose files no longer exist
    let removed = {
        let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
        db.remove_missing_tracks().unwrap_or(0)
    };

    // Emit completion event for UI progress bar
    let _ = app.emit(
        "scan-progress",
        serde_json::json!({
            "total_files": total_files,
            "processed_files": total_files,
            "current_file": "",
            "status": "complete",
        }),
    );

    let result = serde_json::json!({
        "total_tracks": total_files,
        "new_tracks": new_tracks,
        "removed_tracks": removed,
    });

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
pub fn get_all_tracks(db: State<'_, Mutex<Database>>) -> Result<Vec<Track>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_all_tracks()
        .map_err(|e| format!("Failed to get tracks: {}", e))
}

/// Get all albums in the library.
///
/// Frontend: `const albums = await invoke('get_albums')`
#[tauri::command]
pub fn get_albums(db: State<'_, Mutex<Database>>) -> Result<Vec<Album>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_albums()
        .map_err(|e| format!("Failed to get albums: {}", e))
}

/// Get all artists in the library.
///
/// Frontend: `const artists = await invoke('get_artists')`
#[tauri::command]
pub fn get_artists(db: State<'_, Mutex<Database>>) -> Result<Vec<Artist>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_artists()
        .map_err(|e| format!("Failed to get artists: {}", e))
}

/// Get all genre names in the library.
///
/// Frontend: `const genres = await invoke('get_genres')`
#[tauri::command]
pub fn get_genres(db: State<'_, Mutex<Database>>) -> Result<Vec<String>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_genres()
        .map_err(|e| format!("Failed to get genres: {}", e))
}

/// Search across tracks, albums, and artists.
///
/// Frontend: `const results = await invoke('search', { query: 'beatles' })`
///
/// Returns a SearchResults object with matching tracks, albums, and artists.
#[tauri::command]
pub fn search(query: String, db: State<'_, Mutex<Database>>) -> Result<SearchResults, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;

    // Search tracks
    let tracks = db
        .search_tracks(&query)
        .map_err(|e| format!("Search failed: {}", e))?;

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
    albums.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    // Derive matching artists, counting tracks and unique albums per artist
    struct ArtistAcc {
        track_count: u32,
        albums: std::collections::HashSet<String>,
    }
    let mut artist_map: std::collections::HashMap<String, ArtistAcc> = std::collections::HashMap::new();
    for track in &tracks {
        let acc = artist_map.entry(track.artist.clone()).or_insert_with(|| ArtistAcc {
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
    artists.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

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
) -> Result<Option<ArtworkPayload>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;

    let track = db
        .get_track(&track_id)
        .map_err(|e| format!("Database error: {}", e))?;

    let track = match track {
        Some(t) => t,
        None => return Ok(None),
    };

    let meta = match metadata::extract_metadata(&track.file_path) {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };

    // Try embedded artwork first, then fall back to common folder image files
    let artwork_bytes = meta.artwork.or_else(|| {
        let path = std::path::Path::new(&track.file_path);
        if let Some(parent) = path.parent() {
            let common_names = [
                "cover.jpg", "cover.jpeg", "cover.png",
                "folder.jpg", "folder.jpeg", "folder.png",
                "front.jpg", "front.jpeg", "front.png",
                "Artwork.jpg", "Artwork.jpeg", "Artwork.png",
            ];
            for entry in std::fs::read_dir(parent).ok()?.flatten() {
                if let Ok(file_type) = entry.file_type() {
                    if file_type.is_file() {
                        if let Some(file_name) = entry.file_name().to_str() {
                            let file_name_lower = file_name.to_lowercase();
                            if common_names.iter().any(|name| file_name_lower == name.to_lowercase()) {
                                if let Ok(bytes) = std::fs::read(entry.path()) {
                                    return Some(bytes);
                                }
                            }
                        }
                    }
                }
            }
        }
        None
    });

    match artwork_bytes {
        Some(bytes) => {
            let mime_type = detect_image_mime(&bytes);
            Ok(Some(ArtworkPayload {
                data: base64_encode(&bytes),
                mime_type,
            }))
        }
        None => Ok(None),
    }
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

    let mut result = String::with_capacity((data.len() + 2) / 3 * 4);
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
