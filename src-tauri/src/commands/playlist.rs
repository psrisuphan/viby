use tauri::State;

use crate::error::AppError;
use crate::library::database::Database;
use crate::models::{Playlist, Track};

#[tauri::command]
pub fn create_playlist(name: String, db: State<'_, Database>) -> Result<Playlist, AppError> {
    let now = crate::utils::current_timestamp();
    let playlist = Playlist {
        id: uuid::Uuid::new_v4().to_string(),
        name,
        track_count: 0,
        created_at: now.clone(),
        updated_at: now,
    };
    db.create_playlist(&playlist).map_err(AppError::from)?;
    Ok(playlist)
}

#[tauri::command]
pub fn delete_playlist(id: String, db: State<'_, Database>) -> Result<(), AppError> {
    db.delete_playlist(&id).map_err(AppError::from)
}

#[tauri::command]
pub fn rename_playlist(id: String, name: String, db: State<'_, Database>) -> Result<(), AppError> {
    db.rename_playlist(&id, &name).map_err(AppError::from)
}

#[tauri::command]
pub fn get_playlists(db: State<'_, Database>) -> Result<Vec<Playlist>, AppError> {
    db.get_playlists().map_err(AppError::from)
}

#[tauri::command]
pub fn get_playlist_tracks(
    playlist_id: String,
    db: State<'_, Database>,
) -> Result<Vec<Track>, AppError> {
    db.get_playlist_tracks(&playlist_id).map_err(AppError::from)
}

#[tauri::command]
pub fn add_to_playlist(
    playlist_id: String,
    track_ids: Vec<String>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    db.add_tracks_to_playlist(&playlist_id, &track_ids)
        .map_err(AppError::from)
}

#[tauri::command]
pub fn remove_from_playlist(
    playlist_id: String,
    track_id: String,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    db.remove_track_from_playlist(&playlist_id, &track_id)
        .map_err(AppError::from)
}

#[tauri::command]
pub fn reorder_playlist(
    playlist_id: String,
    track_ids: Vec<String>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    db.reorder_playlist(&playlist_id, &track_ids)
        .map_err(AppError::from)
}
