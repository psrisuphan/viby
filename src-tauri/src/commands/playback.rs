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

use tauri::{AppHandle, Emitter, State, Manager};

use crate::audio::eq::PEQ_BAND_COUNT;
use crate::audio::player::AudioPlayer;
use crate::audio::queue::PlaybackQueue;
use crate::error::AppError;
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

// QueueState is defined in audio/queue.rs and re-exported here for convenience.
pub use crate::audio::queue::QueueState;

// =============================================================================
// Playback commands
// =============================================================================

/// Play a track by its library ID.
/// The track must exist in the database — no silent metadata-extraction fallback.
/// Frontend: `invoke('play_track', { trackId: 'uuid' })`
#[tauri::command]
pub fn play_track(
    track_id: String,
    app: tauri::AppHandle,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let track = {
        let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let t = db.get_track(&track_id).map_err(AppError::from)?
            .ok_or_else(|| AppError::NotFound(format!("Track '{}' not found in library", track_id)))?;
        let _ = db.record_play(&track_id);
        t
    };

    let path = track.file_path.clone();
    {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
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

/// Update the 10-band equalizer.
/// Frontend: `invoke('set_eq', { enabled, preamp, gains: [..10 dB..] })`
///
/// # Arguments
/// * `enabled` — master on/off (off = bit-transparent bypass)
/// * `preamp` — global pre-amp gain in dB (compensates for boosting bands)
/// * `gains` — per-band gain in dB (up to 10 values; missing = 0)
#[tauri::command]
pub fn set_eq(
    enabled: bool,
    preamp: f32,
    gains: Vec<f32>,
    player: State<'_, AudioPlayer>,
) {
    let mut g_arr = [0f32; 10];
    for (slot, g) in g_arr.iter_mut().zip(gains) {
        *slot = g;
    }
    player.set_eq(enabled, preamp, g_arr);
}

/// Per-band parameters for the parametric EQ.
#[derive(serde::Deserialize)]
pub struct PeqBandParam {
    pub enabled:     bool,
    pub filter_type: u8,
    pub freq:        f32,
    pub gain:        f32,
    pub q:           f32,
}

/// Update the 8-band parametric equalizer.
/// Frontend: `invoke('set_peq', { enabled, preamp, bands: [{enabled, filter_type, freq, gain, q}] })`
#[tauri::command]
pub fn set_peq(
    enabled: bool,
    preamp:  f32,
    bands:   Vec<PeqBandParam>,
    player:  State<'_, AudioPlayer>,
) {
    let mut arr = [(true, 0u8, 1000f32, 0f32, 1f32); PEQ_BAND_COUNT];
    for (slot, b) in arr.iter_mut().zip(bands.iter()) {
        *slot = (b.enabled, b.filter_type, b.freq, b.gain, b.q);
    }
    player.set_peq(enabled, preamp, arr);
}

/// Set EQ oversampling ratio (1, 2, or 4). Default is 2.
/// Frontend: `invoke('set_eq_oversampling', { ratio: 2 })`
#[tauri::command]
pub fn set_eq_oversampling(ratio: u8, player: State<'_, AudioPlayer>) {
    player.set_eq_oversampling(ratio);
}

/// Set EQ filter topology (0 = TDF2, 1 = SVF). Default is 0.
/// Frontend: `invoke('set_eq_topology', { mode: 0 })`
#[tauri::command]
pub fn set_eq_topology(mode: u8, player: State<'_, AudioPlayer>) {
    player.set_eq_topology(mode);
}

/// Export current PEQ to a standard format string.
/// Supported formats: "apo", "camilladsp", "easyeffects", "pipewire", "roon", "wavelet"
/// Frontend: `const config = await invoke('export_peq', { format: 'apo' })`
#[tauri::command]
pub fn export_peq(format: String, player: State<'_, AudioPlayer>) -> Result<String, String> {
    let snap = player.eq_params().snapshot();
    if !snap.peq_mode {
        return Err("Not in PEQ mode. Switch to parametric EQ first.".to_string());
    }

    // Build a Peq vector from current bands
    let peq: math_audio_iir_fir::Peq<f64> = snap.peq_bands
        .iter()
        .filter(|b| b.enabled)
        .map(|b| {
            let bq = math_audio_iir_fir::Biquad::new(
                match b.filter_type {
                    1 => math_audio_iir_fir::BiquadFilterType::Lowshelf,
                    2 => math_audio_iir_fir::BiquadFilterType::Highshelf,
                    3 => math_audio_iir_fir::BiquadFilterType::Lowpass,
                    4 => math_audio_iir_fir::BiquadFilterType::Highpass,
                    _ => math_audio_iir_fir::BiquadFilterType::Peak,
                },
                b.freq as f64,
                48000.0,
                b.q.max(0.01) as f64,
                b.gain as f64,
            );
            (1.0f64, bq)
        })
        .collect();

    let result = match format.as_str() {
        "apo" => math_audio_iir_fir::peq_format_apo("Viby PEQ Export", &peq),
        "camilladsp" => math_audio_iir_fir::peq_format_camilladsp("Viby PEQ Export", &peq, 48000),
        "easyeffects" => math_audio_iir_fir::peq_format_easyeffects("Viby PEQ Export", &peq),
        "pipewire" => math_audio_iir_fir::peq_format_pipewire("Viby PEQ Export", &peq),
        "roon" => math_audio_iir_fir::peq_format_roon("Viby PEQ Export", &peq),
        "wavelet" => math_audio_iir_fir::peq_format_wavelet("Viby PEQ Export", &peq, 48000.0),
        _ => return Err(format!("Unsupported format: '{}'. Supported: apo, camilladsp, easyeffects, pipewire, roon, wavelet", format)),
    };

    Ok(result)
}

/// Skip to the next track in the queue.
/// Frontend: `invoke('next_track', { userInitiated: true })`
#[tauri::command]
pub fn next_track(
    app: tauri::AppHandle,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;

    let is_user = user_initiated.unwrap_or(true);

    if let Some(track) = q.next(is_user).cloned() {
        if let Ok(db) = db.lock() { let _ = db.record_play(&track.id); }
        let path = track.file_path.clone();
        player.load_track(&path, track);
    } else {
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
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;

    let is_user = user_initiated.unwrap_or(true);

    if let Some(track) = q.previous(is_user).cloned() {
        if let Ok(db) = db.lock() { let _ = db.record_play(&track.id); }
        let path = track.file_path.clone();
        player.load_track(&path, track);
    }

    emit_queue_changed(&app, &q);

    Ok(())
}

/// Enable or disable shuffle mode.
/// Frontend: `invoke('set_shuffle', { enabled: true })`
#[tauri::command]
pub fn set_shuffle(app: tauri::AppHandle, enabled: bool, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
pub fn set_repeat(app: tauri::AppHandle, mode: String, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
pub fn get_queue(queue: State<'_, QueueState>) -> Result<QueuePayload, AppError> {
    let q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.add(track);
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn add_tracks_to_queue(
    app: tauri::AppHandle,
    tracks: Vec<Track>,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.add_many(tracks);
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn remove_from_queue(
    app: tauri::AppHandle,
    index: usize,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.move_item(from, to);
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_all(
    app: tauri::AppHandle,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.clear_keeping_current();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_up_next(
    app: tauri::AppHandle,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.clear_up_next();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_history(
    app: tauri::AppHandle,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
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
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;

    if let Some(track) = q.jump_to(index).cloned() {
        if let Ok(db) = db.lock() { let _ = db.record_play(&track.id); }
        let path = track.file_path.clone();
        player.load_track(&path, track);
        emit_queue_changed(&app, &q);
    }

    Ok(())
}

#[derive(serde::Serialize)]
pub struct TargetCurve {
    pub name: String,
    pub points: Vec<(f32, f32)>,
}

#[tauri::command]
pub fn get_target_curves(app: tauri::AppHandle) -> Result<Vec<TargetCurve>, String> {
    use std::collections::HashSet;
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    // 1. Start with curves compiled into the binary
    let mut curves = crate::embedded_curves::get_embedded_curves();
    let seen: HashSet<String> = curves.iter().map(|c| c.name.clone()).collect();

    // 2. Supplement with user-imported curves from the filesystem.
    //    Search order:
    //      a) Arch Linux package: /usr/share/viby/target-reference/
    //      b) CWD / target-reference/
    //      c) Parent CWD / target-reference/
    //      d) App data dir / target-reference/
    //      e) Tauri bundled resources
    let candidates: [PathBuf; 5] = [
        // Arch Linux / Unix share path (set by PKGBUILD package())
        PathBuf::from("/usr/share/viby/target-reference"),
        // CWD (dev mode)
        std::env::current_dir()
            .map(|p| p.join("target-reference"))
            .unwrap_or_default(),
        // Parent directory (dev mode, sub-project layout)
        std::env::current_dir()
            .map(|p| p.join("../target-reference"))
            .unwrap_or_default(),
        // App data dir
        app.path().app_data_dir()
            .map(|d| d.join("target-reference"))
            .unwrap_or_default(),
        // Tauri bundled resources
        app.path().resolve("target-reference", tauri::path::BaseDirectory::Resource)
            .unwrap_or_default(),
    ];

    let target_dir = candidates.into_iter().find(|p| p.exists());

    if let Some(target_dir) = target_dir {
        let entries = fs::read_dir(&target_dir).map_err(|e| e.to_string())?;

        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file()
                || (path.extension().and_then(|ext| ext.to_str()) != Some("txt")) {
                continue;
            }
            let name = path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Unknown".to_string());

            // Skip if already embedded (avoids duplicates)
            if seen.contains(&name) {
                continue;
            }

            if let Ok(content) = fs::read_to_string(&path) {
                let mut points = Vec::new();
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    let parts: Vec<&str> = trimmed.split_whitespace().collect();
                    if parts.len() >= 2
                        && let (Ok(freq), Ok(db)) = (parts[0].parse::<f32>(), parts[1].parse::<f32>()) {
                            points.push((freq, db));
                        }
                }
                if !points.is_empty() {
                    curves.push(TargetCurve { name, points });
                }
            }
        }
    }

    curves.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(curves)
}

#[tauri::command]
pub fn import_target_curve(
    file_path: String,
    app: tauri::AppHandle,
) -> Result<TargetCurve, String> {
    use std::fs;
    use std::path::Path;
    use tauri::Manager;

    let src_path = Path::new(&file_path);
    if !src_path.exists() || !src_path.is_file() {
        return Err("Source file does not exist or is not a file".to_string());
    }

    // 1. Validate file content (frequency amplitude pairs)
    let content = fs::read_to_string(src_path).map_err(|e| format!("Failed to read file: {}", e))?;
    let mut points = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 2
            && let (Ok(freq), Ok(db)) = (parts[0].parse::<f32>(), parts[1].parse::<f32>()) {
                points.push((freq, db));
            }
    }

    if points.is_empty() {
        return Err("Invalid file format: no valid frequency-amplitude pairs found".to_string());
    }

    // 2. Resolve destination target-reference folder
    // Try to find the target-reference folder in current_dir or parent
    let mut target_dir = std::env::current_dir()
        .map(|p| p.join("target-reference"))
        .unwrap_or_else(|_| std::path::PathBuf::from("target-reference"));

    if !target_dir.exists()
        && let Ok(curr) = std::env::current_dir() {
            let parent_target = curr.join("../target-reference");
            if parent_target.exists() {
                target_dir = parent_target;
            }
        }

    // If still not exists (e.g. production release), write to app data dir
    if !target_dir.exists()
        && let Ok(app_dir) = app.path().app_data_dir() {
            target_dir = app_dir.join("target-reference");
        }

    // Create directory if it does not exist
    if !target_dir.exists() {
        fs::create_dir_all(&target_dir).map_err(|e| format!("Failed to create target-reference directory: {}", e))?;
    }

    // 3. Save file to destination directory
    let file_name = src_path.file_name()
        .ok_or_else(|| "Invalid file name".to_string())?;
    
    let dest_path = target_dir.join(file_name);
    fs::copy(src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;

    let name = dest_path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Unknown".to_string());

    Ok(TargetCurve { name, points })
}

#[tauri::command]
pub fn delete_target_curve(
    name: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;
    
    // Resolve target-reference folder
    let mut target_dir = std::env::current_dir()
        .map(|p| p.join("target-reference"))
        .unwrap_or_else(|_| std::path::PathBuf::from("target-reference"));

    if !target_dir.exists()
        && let Ok(curr) = std::env::current_dir() {
            let parent_target = curr.join("../target-reference");
            if parent_target.exists() {
                target_dir = parent_target;
            }
        }

    if !target_dir.exists()
        && let Ok(app_dir) = app.path().app_data_dir() {
            target_dir = app_dir.join("target-reference");
        }

    if !target_dir.exists() {
        return Err("Target reference folder not found".to_string());
    }

    // Find the file with the matching stem
    let txt_path = target_dir.join(format!("{}.txt", name));
    let csv_path = target_dir.join(format!("{}.csv", name));

    if txt_path.exists() {
        fs::remove_file(txt_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else if csv_path.exists() {
        fs::remove_file(csv_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else {
        return Err("Curve file not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn get_headphone_measurements(app: tauri::AppHandle) -> Result<Vec<TargetCurve>, String> {
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    let candidates: [PathBuf; 5] = [
        // Arch Linux / Unix share path (set by PKGBUILD package())
        PathBuf::from("/usr/share/viby/headphone-measurements"),
        // CWD (dev mode)
        std::env::current_dir()
            .map(|p| p.join("headphone-measurements"))
            .unwrap_or_default(),
        // Parent directory (dev mode)
        std::env::current_dir()
            .map(|p| p.join("../headphone-measurements"))
            .unwrap_or_default(),
        // App data dir
        app.path().app_data_dir()
            .map(|d| d.join("headphone-measurements"))
            .unwrap_or_default(),
        // Tauri bundled resources
        app.path().resolve("headphone-measurements", tauri::path::BaseDirectory::Resource)
            .unwrap_or_default(),
    ];

    let measurements_dir = match candidates.into_iter().find(|p| p.exists()) {
        Some(d) => d,
        None => return Ok(Vec::new()),
    };

    let entries = fs::read_dir(&measurements_dir).map_err(|e| e.to_string())?;
    let mut curves = Vec::new();

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file() && (path.extension().is_some_and(|ext| ext == "txt" || ext == "csv"))
            && let Ok(content) = fs::read_to_string(&path) {
                let mut points = Vec::new();
                for line in content.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() || trimmed.starts_with('#') {
                        continue;
                    }
                    let parts: Vec<&str> = trimmed.split_whitespace().collect();
                    if parts.len() >= 2
                        && let (Ok(freq), Ok(db)) = (parts[0].parse::<f32>(), parts[1].parse::<f32>()) {
                            points.push((freq, db));
                        }
                }
                if !points.is_empty() {
                    let name = path.file_stem()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "Unknown".to_string());
                    curves.push(TargetCurve { name, points });
                }
            }
    }

    curves.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(curves)
}

#[tauri::command]
pub fn import_headphone_measurement(
    file_path: String,
    app: tauri::AppHandle,
) -> Result<TargetCurve, String> {
    use std::fs;
    use std::path::Path;
    use tauri::Manager;

    let src_path = Path::new(&file_path);
    if !src_path.exists() || !src_path.is_file() {
        return Err("Source file does not exist or is not a file".to_string());
    }

    // 1. Validate file content (frequency amplitude pairs)
    let content = fs::read_to_string(src_path).map_err(|e| format!("Failed to read file: {}", e))?;
    let mut points = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() >= 2
            && let (Ok(freq), Ok(db)) = (parts[0].parse::<f32>(), parts[1].parse::<f32>()) {
                points.push((freq, db));
            }
    }

    if points.is_empty() {
        return Err("Invalid file format: no valid frequency-amplitude pairs found".to_string());
    }

    // 2. Resolve destination folder
    let mut measurements_dir = std::env::current_dir()
        .map(|p| p.join("headphone-measurements"))
        .unwrap_or_else(|_| std::path::PathBuf::from("headphone-measurements"));

    if !measurements_dir.exists()
        && let Ok(curr) = std::env::current_dir() {
            let parent_measurements = curr.join("../headphone-measurements");
            if parent_measurements.exists() {
                measurements_dir = parent_measurements;
            }
        }

    if !measurements_dir.exists()
        && let Ok(app_dir) = app.path().app_data_dir() {
            measurements_dir = app_dir.join("headphone-measurements");
        }

    // Create directory if it does not exist
    if !measurements_dir.exists() {
        fs::create_dir_all(&measurements_dir).map_err(|e| format!("Failed to create headphone-measurements directory: {}", e))?;
    }

    // 3. Save file to destination directory
    let file_name = src_path.file_name()
        .ok_or_else(|| "Invalid file name".to_string())?;
    
    let dest_path = measurements_dir.join(file_name);
    fs::copy(src_path, &dest_path).map_err(|e| format!("Failed to copy file: {}", e))?;

    let name = dest_path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Unknown".to_string());

    Ok(TargetCurve { name, points })
}

#[tauri::command]
pub fn delete_headphone_measurement(
    name: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    use std::fs;
    use tauri::Manager;
    
    let mut measurements_dir = std::env::current_dir()
        .map(|p| p.join("headphone-measurements"))
        .unwrap_or_else(|_| std::path::PathBuf::from("headphone-measurements"));

    if !measurements_dir.exists()
        && let Ok(curr) = std::env::current_dir() {
            let parent_measurements = curr.join("../headphone-measurements");
            if parent_measurements.exists() {
                measurements_dir = parent_measurements;
            }
        }

    if !measurements_dir.exists()
        && let Ok(app_dir) = app.path().app_data_dir() {
            measurements_dir = app_dir.join("headphone-measurements");
        }

    if !measurements_dir.exists() {
        return Err("Headphone measurements folder not found".to_string());
    }

    let txt_path = measurements_dir.join(format!("{}.txt", name));
    let csv_path = measurements_dir.join(format!("{}.csv", name));

    if txt_path.exists() {
        fs::remove_file(txt_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else if csv_path.exists() {
        fs::remove_file(csv_path).map_err(|e| format!("Failed to delete file: {}", e))?;
    } else {
        return Err("Measurement file not found".to_string());
    }

    Ok(())
}

#[tauri::command]
pub fn read_text_file(file_path: String) -> Result<String, String> {
    use std::fs;
    fs::read_to_string(file_path).map_err(|e| format!("Failed to read file: {}", e))
}

#[tauri::command]
pub fn set_gpu_acceleration(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let gpu_settings_path = app_data_dir.join("gpu_settings.json");
    let json = serde_json::json!({
        "gpu_acceleration": enabled
    });
    std::fs::write(&gpu_settings_path, serde_json::to_string_pretty(&json).unwrap())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn set_close_to_tray(enabled: bool, state: tauri::State<'_, crate::CloseToTrayState>) {
    state.0.store(enabled, std::sync::atomic::Ordering::SeqCst);
}
