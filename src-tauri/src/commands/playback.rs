// =============================================================================
// commands/playback.rs — Tauri commands for audio playback control
// =============================================================================
//
// These are the functions the frontend calls via `invoke('command_name', args)`.
// Each function marked with `#[tauri::command]` becomes available in JavaScript.
//
// Tauri automatically:
//   - Deserializes arguments from JSON
//   - Serializes return values to JSON
//   - Runs async commands on a thread pool
//
// Think of these like Express.js route handlers, but instead of HTTP requests,
// they handle IPC (inter-process communication) calls from the frontend.
// =============================================================================

use std::sync::Mutex;

use tauri::{AppHandle, Emitter, State};

use crate::audio::player::AudioPlayer;
use crate::audio::queue::PlaybackQueue;
use crate::library::database::Database;
use crate::models::{PlaybackState, QueuePayload, RepeatMode, Track};

// =============================================================================
// Helper functions
// =============================================================================

/// Emits the `queue-changed` event to the frontend
fn emit_queue_changed(app: &AppHandle, q: &PlaybackQueue) {
    let payload = QueuePayload {
        tracks: q.get_play_order_tracks(),
        current_index: q.get_current_index(),
    };
    let _ = app.emit("queue-changed", &payload);
}

// =============================================================================
// State types — these are stored in Tauri's managed state
// =============================================================================

/// Wrapper for the playback queue in Tauri's managed state.
/// Mutex is needed because Tauri commands can run concurrently.
pub struct QueueState(pub Mutex<PlaybackQueue>);

// =============================================================================
// Playback commands
// =============================================================================

/// Play a track by its file path.
///
/// This loads the track into the audio engine and starts playback.
/// The frontend calls: `invoke('play_track', { path: '/path/to/song.mp3' })`
///
/// Returns the track information if found in the database, or plays it directly.
#[tauri::command]
pub fn play_track(
    path: String,
    app: tauri::AppHandle,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), String> {
    // Try to find the track in the database by its file path
    let track = {
        let db = db.lock().map_err(|e| format!("Database lock error: {}", e))?;
        db.get_track_by_path(&path)
            .map_err(|e| format!("Database error: {}", e))?
    };

    // If not in the database, create a temporary Track from metadata
    let track = match track {
        Some(t) => t,
        None => {
            // Extract metadata from the file directly
            let meta = crate::library::metadata::extract_metadata(&path)?;
            Track {
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
                date_added: String::new(),
            }
        }
    };

    // Update queue
    {
        let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
        q.play_now(track.clone());
        emit_queue_changed(&app, &q);
    }

    player.load_track(&path, track);
    Ok(())
}

/// Pause the current playback.
/// Frontend: `invoke('pause')`
#[tauri::command]
pub fn pause(player: State<'_, AudioPlayer>) {
    player.pause();
}

/// Resume playback after pausing.
/// Frontend: `invoke('resume')`
#[tauri::command]
pub fn resume(player: State<'_, AudioPlayer>) {
    player.resume();
}

/// Stop playback and clear the current track.
/// Frontend: `invoke('stop')`
#[tauri::command]
pub fn stop(player: State<'_, AudioPlayer>) {
    player.stop();
}

/// Seek to a specific position in the current track.
/// Frontend: `invoke('seek', { positionSecs: 30.5 })`
///
/// # Arguments
/// * `position_secs` — position in seconds to seek to
#[tauri::command]
pub fn seek(position_secs: f64, player: State<'_, AudioPlayer>) {
    player.seek(position_secs);
}

/// Set the playback volume.
/// Frontend: `invoke('set_volume', { volume: 0.75 })`
///
/// # Arguments
/// * `volume` — volume level from 0.0 (mute) to 1.0 (full volume)
#[tauri::command]
pub fn set_volume(volume: f32, player: State<'_, AudioPlayer>) {
    player.set_volume(volume);
}

/// Skip to the next track in the queue.
/// Frontend: `invoke('next_track', { userInitiated: true })`
#[tauri::command]
pub fn next_track(
    app: tauri::AppHandle,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;

    let is_user = user_initiated.unwrap_or(true);

    // Get the next track from the queue
    if let Some(track) = q.next(is_user).cloned() {
        let path = track.file_path.clone();
        player.load_track(&path, track);
    } else {
        // No more tracks — stop playback
        player.stop();
    }
    
    emit_queue_changed(&app, &q);

    Ok(())
}

/// Go back to the previous track in the queue.
/// Frontend: `invoke('previous_track', { userInitiated: true })`
#[tauri::command]
pub fn previous_track(
    app: tauri::AppHandle,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;

    let is_user = user_initiated.unwrap_or(true);

    if let Some(track) = q.previous(is_user).cloned() {
        let path = track.file_path.clone();
        player.load_track(&path, track);
    }
    
    emit_queue_changed(&app, &q);

    Ok(())
}

/// Enable or disable shuffle mode.
/// Frontend: `invoke('set_shuffle', { enabled: true })`
#[tauri::command]
pub fn set_shuffle(app: tauri::AppHandle, enabled: bool, queue: State<'_, QueueState>) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.set_shuffle(enabled);
    emit_queue_changed(&app, &q);
    Ok(())
}

/// Set the repeat mode.
/// Frontend: `invoke('set_repeat', { mode: 'all' })`
///
/// # Arguments
/// * `mode` — one of: "off", "one", "all"
#[tauri::command]
pub fn set_repeat(app: tauri::AppHandle, mode: String, queue: State<'_, QueueState>) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.set_repeat_mode(RepeatMode::from_str(&mode));
    emit_queue_changed(&app, &q);
    Ok(())
}

/// Get the current playback state (what's playing, position, volume, etc.).
/// Frontend: `const state = await invoke('get_playback_state')`
///
/// This is a "pull" alternative to the "push" events emitted by the player.
/// Use events for real-time updates, and this command for initial state.
#[tauri::command]
pub fn get_playback_state(
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
) -> PlaybackState {
    let mut state = player.get_state();

    // Overlay queue state (shuffle & repeat) onto the playback state
    if let Ok(q) = queue.0.lock() {
        state.shuffle = q.is_shuffle();
        state.repeat_mode = q.get_repeat_mode().as_str().to_string();
    }

    state
}

// =============================================================================
// Queue management commands
// =============================================================================

#[tauri::command]
pub fn get_queue(queue: State<'_, QueueState>) -> Result<QueuePayload, String> {
    let q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    Ok(QueuePayload {
        tracks: q.get_play_order_tracks(),
        current_index: q.get_current_index(),
    })
}

#[tauri::command]
pub fn add_to_queue(
    app: tauri::AppHandle,
    track: Track,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.add(track);
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn remove_from_queue(
    app: tauri::AppHandle,
    index: usize,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.remove(index);
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn reorder_queue(
    app: tauri::AppHandle,
    from: usize,
    to: usize,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.move_item(from, to);
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_all(
    app: tauri::AppHandle,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.clear();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_up_next(
    app: tauri::AppHandle,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.clear_up_next();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_history(
    app: tauri::AppHandle,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    q.clear_history();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn play_queue_index(
    app: tauri::AppHandle,
    index: usize,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
) -> Result<(), String> {
    let mut q = queue.0.lock().map_err(|e| format!("Queue lock error: {}", e))?;
    
    if let Some(track) = q.jump_to(index).cloned() {
        let path = track.file_path.clone();
        player.load_track(&path, track);
        emit_queue_changed(&app, &q);
    }
    
    Ok(())
}
