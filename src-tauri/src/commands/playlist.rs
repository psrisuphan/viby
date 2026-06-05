// =============================================================================
// commands/playlist.rs — Tauri commands for playlist management
// =============================================================================
//
// CRUD operations for playlists:
//   - Create, rename, delete playlists
//   - Add/remove tracks from playlists
//   - Reorder tracks within a playlist
//   - Get playlist details and tracks
// =============================================================================

use std::sync::Mutex;

use tauri::State;

use crate::library::database::Database;
use crate::models::{Playlist, Track};

// =============================================================================
// Playlist CRUD
// =============================================================================

/// Create a new playlist.
///
/// Frontend: `const playlist = await invoke('create_playlist', { name: 'My Favorites' })`
///
/// Returns the created Playlist object.
#[tauri::command]
pub fn create_playlist(
    name: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Playlist, String> {
    let now = crate::utils::current_timestamp();
    let playlist = Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        track_count: 0,
        created_at: now.clone(),
        updated_at: now,
    };

    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.create_playlist(&playlist)
        .map_err(|e| format!("Failed to create playlist: {}", e))?;

    Ok(playlist)
}

/// Delete a playlist by its ID.
///
/// Frontend: `await invoke('delete_playlist', { id: 'playlist-uuid' })`
#[tauri::command]
pub fn delete_playlist(
    id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.delete_playlist(&id)
        .map_err(|e| format!("Failed to delete playlist: {}", e))
}

/// Rename a playlist.
///
/// Frontend: `await invoke('rename_playlist', { id: 'uuid', name: 'New Name' })`
#[tauri::command]
pub fn rename_playlist(
    id: String,
    name: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.rename_playlist(&id, &name)
        .map_err(|e| format!("Failed to rename playlist: {}", e))
}

/// Get all playlists.
///
/// Frontend: `const playlists = await invoke('get_playlists')`
#[tauri::command]
pub fn get_playlists(
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<Playlist>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_playlists()
        .map_err(|e| format!("Failed to get playlists: {}", e))
}

/// Get all tracks in a specific playlist.
///
/// Frontend: `const tracks = await invoke('get_playlist_tracks', { playlistId: 'uuid' })`
#[tauri::command]
pub fn get_playlist_tracks(
    playlist_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Vec<Track>, String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.get_playlist_tracks(&playlist_id)
        .map_err(|e| format!("Failed to get playlist tracks: {}", e))
}

// =============================================================================
// Playlist track management
// =============================================================================

/// Add tracks to a playlist.
///
/// Frontend: `await invoke('add_to_playlist', { playlistId: 'uuid', trackIds: ['id1', 'id2'] })`
#[tauri::command]
pub fn add_to_playlist(
    playlist_id: String,
    track_ids: Vec<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.add_tracks_to_playlist(&playlist_id, &track_ids)
        .map_err(|e| format!("Failed to add tracks to playlist: {}", e))
}

/// Remove a track from a playlist.
///
/// Frontend: `await invoke('remove_from_playlist', { playlistId: 'uuid', trackId: 'track-uuid' })`
#[tauri::command]
pub fn remove_from_playlist(
    playlist_id: String,
    track_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.remove_track_from_playlist(&playlist_id, &track_id)
        .map_err(|e| format!("Failed to remove track from playlist: {}", e))
}

/// Reorder tracks in a playlist.
/// Pass the track IDs in the new desired order.
///
/// Frontend: `await invoke('reorder_playlist', { playlistId: 'uuid', trackIds: ['id3', 'id1', 'id2'] })`
#[tauri::command]
pub fn reorder_playlist(
    playlist_id: String,
    track_ids: Vec<String>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
    db.reorder_playlist(&playlist_id, &track_ids)
        .map_err(|e| format!("Failed to reorder playlist: {}", e))
}

