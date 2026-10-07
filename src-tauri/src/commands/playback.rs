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

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Instant;

use tauri::{AppHandle, Manager, State};
pub use super::curves::{
    BoundedCurvePoints, ImportedTextFile, TargetCurve, add_headphone_measurement,
    delete_headphone_measurement, delete_target_curve, get_headphone_measurements,
    get_target_curves, import_headphone_measurement, import_target_curve, pick_eq_filter_file,
};

use crate::audio::dsp::BandConfig;
use crate::audio::eq::{BAND_COUNT, PEQ_BAND_COUNT};
use crate::audio::eq::{graphic_band_configs, response_db_at};
use crate::audio::player::AudioPlayer;
use crate::commands::queue_events::{emit_queue_changed, emit_queue_position_changed};
use crate::error::AppError;
use crate::library::{database::Database, metadata, scanner};
use crate::models::{PlaybackState, QueuePayload, RepeatMode, Track, TrackEqOverride};

// =============================================================================
// Helper functions
// =============================================================================

fn record_play(db: &Database, track_id: &str, context: &str) {
    if let Err(error) = db.record_play(track_id) {
        eprintln!("[PlaybackCommand] Failed to record play for {track_id} ({context}): {error}");
    }
}

pub(crate) fn playback_debug_enabled() -> bool {
    std::env::var("VIBY_PLAYBACK_DEBUG")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
        .unwrap_or(false)
}

fn debug_log_event(event_type: &str, message: &str) {
    if playback_debug_enabled() {
        crate::utils::log_rust_event(event_type, message);
    }
}

fn gains_array(gains: Vec<f32>) -> [f32; BAND_COUNT] {
    let mut arr = [0f32; BAND_COUNT];
    for (slot, gain) in arr.iter_mut().zip(gains.into_iter()) {
        *slot = gain;
    }
    arr
}

fn validate_gain(value: f32, label: &str) -> Result<(), String> {
    if value.is_finite() && (-12.0..=12.0).contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "{label} must be a finite value between -12 and 12 dB"
        ))
    }
}

pub(crate) fn validate_graphic_eq(preamp: f32, gains: &[f32]) -> Result<(), String> {
    validate_gain(preamp, "preamp")?;
    if gains.len() > BAND_COUNT {
        return Err(format!("at most {BAND_COUNT} graphic EQ bands are allowed"));
    }
    gains
        .iter()
        .try_for_each(|gain| validate_gain(*gain, "gain"))
}

fn apply_track_eq(player: &AudioPlayer, db: &Database, track_id: &str) {
    match db.get_track_eq_override(track_id) {
        Ok(Some(override_)) => player.apply_track_eq_override(
            override_.enabled,
            override_.preamp_db,
            gains_array(override_.gains),
        ),
        _ => player.clear_track_eq_override(),
    }
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
        let t = db
            .get_track(&track_id)
            .map_err(AppError::from)?
            .ok_or_else(|| {
                AppError::NotFound(format!("Track '{}' not found in library", track_id))
            })?;
        record_play(&db, &track_id, "play_track");
        apply_track_eq(&player, &db, &track_id);
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

pub fn open_audio_files(app: &AppHandle, paths: Vec<PathBuf>) -> Result<(), AppError> {
    let db = app.state::<Mutex<Database>>();
    let mut seen = HashSet::new();
    let mut tracks = Vec::new();

    for path in paths {
        let Ok(path) = path.canonicalize() else {
            continue;
        };
        if !path.is_file() || !scanner::is_audio_file(&path) {
            continue;
        }
        let path = path.to_string_lossy().into_owned();
        if !seen.insert(path.clone()) {
            continue;
        }

        let existing = db
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?
            .get_track_by_path(&path)
            .map_err(AppError::from)?;
        let (track, indexed) = if let Some(track) = existing {
            (track, true)
        } else {
            let metadata = match metadata::extract_metadata_no_artwork(&path) {
                Ok(metadata) => metadata,
                Err(error) => {
                    eprintln!("[Viby] Could not open {path}: {error}");
                    continue;
                }
            };
            (
                Track::from_metadata(
                    metadata,
                    uuid::Uuid::new_v4().to_string(),
                    crate::utils::current_timestamp(),
                ),
                false,
            )
        };
        tracks.push((track, indexed));
    }

    let Some((first, first_is_indexed)) = tracks.first().cloned() else {
        return Err(AppError::Other("No supported audio files to open".into()));
    };

    let queue = app.state::<QueueState>();
    {
        let mut queue = queue
            .0
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        queue.clear();
        queue.add_many(tracks.into_iter().map(|(track, _)| track).collect());
        emit_queue_changed(app, &queue);
    }

    let player = app.state::<AudioPlayer>();
    if first_is_indexed {
        if let Ok(db) = db.lock() {
            record_play(&db, &first.id, "open_audio_files");
            apply_track_eq(&player, &db, &first.id);
        }
    } else {
        player.clear_track_eq_override();
    }
    let path = first.file_path.clone();
    player.load_track(&path, first);
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

#[tauri::command]
pub fn set_sound_check_enabled(enabled: bool, player: State<'_, AudioPlayer>) {
    player.set_sound_check_enabled(enabled);
}

#[tauri::command]
pub fn set_sound_check_target_lufs(target_lufs: f32, player: State<'_, AudioPlayer>) {
    player.set_sound_check_target_lufs(target_lufs);
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
) -> Result<(), String> {
    validate_graphic_eq(preamp, &gains)?;
    player.set_eq(enabled, preamp, gains_array(gains));
    Ok(())
}

#[tauri::command]
pub fn get_track_eq_override(
    track_id: String,
    db: State<'_, Mutex<Database>>,
) -> Result<Option<TrackEqOverride>, AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.get_track_eq_override(&track_id).map_err(AppError::from)
}

#[tauri::command]
pub fn save_track_eq_override(
    track_id: String,
    enabled: bool,
    preamp_db: f32,
    gains: Vec<f32>,
    player: State<'_, AudioPlayer>,
    db: State<'_, Mutex<Database>>,
) -> Result<TrackEqOverride, AppError> {
    validate_graphic_eq(preamp_db, &gains).map_err(AppError::Other)?;
    let override_ = TrackEqOverride {
        track_id: track_id.clone(),
        enabled,
        preamp_db,
        gains: gains_array(gains).to_vec(),
        updated_at: crate::utils::current_timestamp(),
    };
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.save_track_eq_override(&override_)
        .map_err(AppError::from)?;
    player.apply_track_eq_override(enabled, preamp_db, gains_array(override_.gains.clone()));
    Ok(override_)
}

#[tauri::command]
pub fn preview_track_eq_override(
    enabled: bool,
    preamp_db: f32,
    gains: Vec<f32>,
    player: State<'_, AudioPlayer>,
) -> Result<(), String> {
    validate_graphic_eq(preamp_db, &gains)?;
    player.apply_track_eq_override(enabled, preamp_db, gains_array(gains));
    Ok(())
}

#[tauri::command]
pub fn clear_track_eq_override(player: State<'_, AudioPlayer>) {
    player.clear_track_eq_override();
}

#[tauri::command]
pub fn delete_track_eq_override(
    track_id: String,
    player: State<'_, AudioPlayer>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let db = db.lock().map_err(|e| AppError::Other(e.to_string()))?;
    db.delete_track_eq_override(&track_id)
        .map_err(AppError::from)?;
    player.clear_track_eq_override();
    Ok(())
}

/// Per-band parameters for the parametric EQ.
#[derive(Clone, Copy, serde::Deserialize)]
pub struct PeqBandParam {
    pub enabled: bool,
    pub filter_type: u8,
    pub freq: f32,
    pub gain: f32,
    pub q: f32,
}

pub(crate) fn validate_peq(preamp: f32, bands: &[PeqBandParam]) -> Result<(), String> {
    validate_gain(preamp, "preamp")?;
    if bands.len() > PEQ_BAND_COUNT {
        return Err(format!(
            "at most {PEQ_BAND_COUNT} parametric EQ bands are allowed"
        ));
    }
    if bands.iter().any(|band| {
        band.filter_type > 4
            || !band.freq.is_finite()
            || !(20.0..=20_000.0).contains(&band.freq)
            || !band.gain.is_finite()
            || !(-12.0..=12.0).contains(&band.gain)
            || !band.q.is_finite()
            || !(0.1..=10.0).contains(&band.q)
    }) {
        return Err("invalid parametric EQ band".to_string());
    }
    Ok(())
}

/// Update the 8-band parametric equalizer.
/// Frontend: `invoke('set_peq', { enabled, preamp, bands: [{enabled, filter_type, freq, gain, q}] })`
#[tauri::command]
pub fn set_peq(
    enabled: bool,
    preamp: f32,
    bands: Vec<PeqBandParam>,
    player: State<'_, AudioPlayer>,
) -> Result<(), String> {
    validate_peq(preamp, &bands)?;
    let mut arr = [(true, 0u8, 1000f32, 0f32, 1f32); PEQ_BAND_COUNT];
    for (slot, b) in arr.iter_mut().zip(bands.iter()) {
        *slot = (b.enabled, b.filter_type, b.freq, b.gain, b.q);
    }
    player.set_peq(enabled, preamp, arr);
    Ok(())
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EqResponseRequest {
    pub mode: String,
    pub enabled: bool,
    pub preamp: f32,
    pub gains: Option<Vec<f32>>,
    pub bands: Option<Vec<PeqBandParam>>,
    pub frequencies: Vec<f32>,
    pub sample_rate: Option<f32>,
}

/// Calculate EQ frequency response in Rust for graphing and analysis.
/// Frontend: `invoke('calculate_eq_response', { request })`
#[tauri::command]
pub fn calculate_eq_response(request: EqResponseRequest) -> Result<Vec<f32>, String> {
    if request.frequencies.len() > 4096 {
        return Err("Too many response points requested".to_string());
    }

    let sample_rate = request.sample_rate.unwrap_or(48_000.0);
    if !sample_rate.is_finite() || sample_rate <= 0.0 {
        return Err("sampleRate must be a positive finite number".to_string());
    }
    validate_gain(request.preamp, "preamp")?;

    if !request.enabled {
        return Ok(vec![0.0; request.frequencies.len()]);
    }

    let bands: Vec<BandConfig> = match request.mode.as_str() {
        "graphic" => {
            validate_graphic_eq(request.preamp, request.gains.as_deref().unwrap_or_default())?;
            let mut gains = [0.0f32; BAND_COUNT];
            if let Some(input_gains) = request.gains {
                for (slot, gain) in gains.iter_mut().zip(input_gains) {
                    *slot = gain;
                }
            }
            graphic_band_configs(&gains)
        }
        "parametric" => {
            let input = request.bands.unwrap_or_default();
            validate_peq(request.preamp, &input)?;
            input
                .into_iter()
                .map(|band| BandConfig {
                    enabled: band.enabled,
                    filter_type: band.filter_type,
                    freq: band.freq as f64,
                    gain_db: band.gain as f64,
                    q: band.q.max(0.01) as f64,
                })
                .collect()
        }
        other => return Err(format!("Unsupported EQ response mode: {other}")),
    };

    Ok(request
        .frequencies
        .into_iter()
        .map(|freq| {
            if freq.is_finite() && freq > 0.0 {
                response_db_at(
                    &bands,
                    freq as f64,
                    request.preamp as f64,
                    sample_rate as f64,
                ) as f32
            } else {
                0.0
            }
        })
        .collect())
}

/// Set EQ oversampling ratio (1, 2, or 4). Default is 2.
/// Frontend: `invoke('set_eq_oversampling', { ratio: 2 })`
#[tauri::command]
pub fn set_eq_oversampling(ratio: u8, player: State<'_, AudioPlayer>) -> Result<(), String> {
    if !matches!(ratio, 1 | 2 | 4) {
        return Err("oversampling ratio must be 1, 2, or 4".to_string());
    }
    player.set_eq_oversampling(ratio);
    Ok(())
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
    let peq: math_audio_iir_fir::Peq<f64> = snap
        .peq_bands
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
        _ => {
            return Err(format!(
                "Unsupported format: '{}'. Supported: apo, camilladsp, easyeffects, pipewire, roon, wavelet",
                format
            ));
        }
    };

    Ok(result)
}

/// Skip to the next track in the queue.
pub(crate) fn advance_to_next(
    app: &AppHandle,
    user_initiated: bool,
    player: &AudioPlayer,
    queue: &QueueState,
    db: &Mutex<Database>,
) -> Result<(), AppError> {
    let started = Instant::now();
    let next = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let next = q.next(user_initiated).cloned();
        emit_queue_position_changed(app, &q);
        next
    };

    if let Some(track) = next {
        if let Ok(db) = db.lock() {
            record_play(&db, &track.id, "next_track");
            apply_track_eq(player, &db, &track.id);
        }
        let path = track.file_path.clone();
        player.load_track(&path, track);
    } else {
        player.stop();
    }

    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] next_track user_initiated={user_initiated} took={:?}",
            started.elapsed()
        );
    }

    Ok(())
}

/// Frontend: `invoke('next_track', { userInitiated: true })`
#[tauri::command]
pub fn next_track(
    app: tauri::AppHandle,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    advance_to_next(&app, user_initiated.unwrap_or(true), &player, &queue, &db)
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
    let started = Instant::now();
    let is_user = user_initiated.unwrap_or(true);
    let previous = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let before = q.get_current_index();
        let previous = q.previous(is_user).cloned();
        if previous.is_some() || q.get_current_index() != before {
            emit_queue_position_changed(&app, &q);
        }
        previous
    };

    if let Some(track) = previous {
        if let Ok(db) = db.lock() {
            record_play(&db, &track.id, "previous_track");
            apply_track_eq(&player, &db, &track.id);
        }
        let path = track.file_path.clone();
        player.load_track(&path, track);
    }

    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] previous_track user_initiated={is_user} took={:?}",
            started.elapsed()
        );
    }

    Ok(())
}

/// Skip multiple tracks in one backend operation.
///
/// Frontend controls use this to batch rapid next/previous clicks so WebKit
/// does not flood the Tauri IPC queue with one command per click.
#[tauri::command]
pub fn skip_tracks(
    app: tauri::AppHandle,
    delta: i32,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Mutex<Database>>,
) -> Result<(), AppError> {
    let started = Instant::now();
    let is_user = user_initiated.unwrap_or(true);
    debug_log_event(
        "skip_tracks",
        &format!("Entered: delta={delta}, user={is_user}"),
    );

    if delta == 0 {
        return Ok(());
    }

    let selected = {
        debug_log_event("skip_tracks", "Locking queue");
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        debug_log_event("skip_tracks", "Queue locked");
        let mut selected = None;

        if delta > 0 {
            for _ in 0..delta {
                selected = q.next(is_user).cloned();
                if selected.is_none() {
                    break;
                }
            }
        } else {
            for _ in 0..delta.unsigned_abs() {
                match q.previous(is_user).cloned() {
                    Some(track) => selected = Some(track),
                    None => break,
                }
            }
        }

        debug_log_event("skip_tracks", "Emitting queue position");
        emit_queue_position_changed(&app, &q);
        selected
    };

    if let Some(track) = selected {
        debug_log_event(
            "skip_tracks",
            &format!("Selected track: id={}, title={}", track.id, track.title),
        );
        if let Ok(db) = db.lock() {
            record_play(&db, &track.id, "skip_tracks");
            apply_track_eq(&player, &db, &track.id);
        }
        let path = track.file_path.clone();
        debug_log_event("skip_tracks", &format!("Loading track: path={}", path));
        player.load_track(&path, track);
        debug_log_event("skip_tracks", "load_track called on player state");
    } else if delta > 0 {
        debug_log_event("skip_tracks", "No track selected; stopping player");
        player.stop();
    }

    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] skip_tracks delta={delta} user_initiated={is_user} took={:?}",
            started.elapsed()
        );
    }
    debug_log_event("skip_tracks", "Completed successfully");

    Ok(())
}

/// Enable or disable shuffle mode.
/// Frontend: `invoke('set_shuffle', { enabled: true })`
#[tauri::command]
pub fn set_shuffle(
    app: tauri::AppHandle,
    enabled: bool,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
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
pub fn set_repeat(
    app: tauri::AppHandle,
    mode: String,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
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
pub fn add_to_queue_next(
    app: tauri::AppHandle,
    track: Track,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.add_next(track);
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
pub fn add_tracks_to_queue_next(
    app: tauri::AppHandle,
    tracks: Vec<Track>,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.add_many_next(tracks);
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
pub fn clear_all(app: tauri::AppHandle, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.clear_keeping_current();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_up_next(app: tauri::AppHandle, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    q.clear_up_next();
    emit_queue_changed(&app, &q);
    Ok(())
}

#[tauri::command]
pub fn clear_history(app: tauri::AppHandle, queue: State<'_, QueueState>) -> Result<(), AppError> {
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
    let selected = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let selected = q.jump_to(index).cloned();
        if selected.is_some() {
            emit_queue_position_changed(&app, &q);
        }
        selected
    };

    if let Some(track) = selected {
        if let Ok(db) = db.lock() {
            record_play(&db, &track.id, "play_queue_index");
            apply_track_eq(&player, &db, &track.id);
        }
        let path = track.file_path.clone();
        player.load_track(&path, track);
    }

    Ok(())
}

#[tauri::command]
pub fn set_gpu_acceleration(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    let gpu_settings_path = app_data_dir.join("gpu_settings.json");
    let json = serde_json::json!({
        "gpu_acceleration": enabled
    });
    std::fs::write(
        &gpu_settings_path,
        serde_json::to_string_pretty(&json).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn get_gpu_acceleration(app: tauri::AppHandle) -> Result<bool, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let gpu_settings_path = app_data_dir.join("gpu_settings.json");
    if gpu_settings_path.exists() {
        let content = std::fs::read_to_string(&gpu_settings_path).map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
        if let Some(enabled) = json.get("gpu_acceleration").and_then(|v| v.as_bool()) {
            return Ok(enabled);
        }
    }
    Ok(!cfg!(target_os = "linux"))
}
