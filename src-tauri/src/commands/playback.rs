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
use std::sync::{Mutex, MutexGuard};
use std::time::Instant;

pub use super::curves::{
    BoundedCurvePoints, ImportedTextFile, TargetCurve, add_headphone_measurement,
    delete_headphone_measurement, delete_target_curve, get_headphone_measurements,
    get_target_curves, import_headphone_measurement, import_target_curve, pick_eq_filter_file,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::audio::dsp::BandConfig;
use crate::audio::eq::{BAND_COUNT, PEQ_BAND_COUNT};
use crate::audio::eq::{graphic_band_configs, response_db_at};
use crate::audio::player::AudioPlayer;
use crate::audio::preferences::{PlaybackPreferences, PlaybackPreferencesStore};
use crate::audio::queue::PlaybackQueue;
use crate::commands::queue_events::{
    emit_queue_payload_changed, emit_queue_position_changed, queue_changed_payload,
    queue_position_payload,
};
use crate::error::AppError;
use crate::library::play_history::PlayHistoryWriter;
use crate::library::{database::Database, metadata, scanner};
use crate::models::{PlaybackState, QueuePayload, RepeatMode, Track, TrackEqOverride};

// =============================================================================
// Helper functions
// =============================================================================

fn record_play(history: &PlayHistoryWriter, track_id: &str, context: &str) {
    if let Err(error) = history.try_record_play(track_id, context) {
        eprintln!("[PlaybackCommand] Could not queue history for {track_id} ({context}): {error}");
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

fn mutate_queue<R>(
    queue: &QueueState,
    update: impl FnOnce(&mut PlaybackQueue) -> R,
) -> Result<(R, QueuePayload), AppError> {
    let mut queue = queue
        .0
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))?;
    let result = update(&mut queue);
    let payload = queue_changed_payload(&queue);
    Ok((result, payload))
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

fn track_eq_override_for_play(db: &Database, track_id: &str) -> Option<TrackEqOverride> {
    db.get_track_eq_override(track_id).ok().flatten()
}

struct PreparedPlaybackTrack {
    track: Track,
}

fn prepare_playback_track(
    db: &Database,
    track_id: &str,
) -> Result<PreparedPlaybackTrack, AppError> {
    let track = resolve_queue_track(db, track_id)?;
    Ok(PreparedPlaybackTrack { track })
}

fn resolve_queue_track(db: &Database, track_id: &str) -> Result<Track, AppError> {
    db.get_track(track_id)?
        .ok_or_else(|| AppError::NotFound(format!("Track '{}' not found in library", track_id)))
}

fn resolve_queue_tracks(db: &Database, track_ids: &[String]) -> Result<Vec<Track>, AppError> {
    db.get_tracks_by_ids(track_ids)?
        .into_iter()
        .zip(track_ids)
        .map(|(track, track_id)| {
            track.ok_or_else(|| {
                AppError::NotFound(format!("Track '{}' not found in library", track_id))
            })
        })
        .collect()
}

struct PlayTracksPlan {
    tracks: Vec<Track>,
    start_index: usize,
    shuffle: bool,
}

fn validate_play_tracks(
    db: &Database,
    track_ids: &[String],
    start_index: usize,
    shuffle: bool,
) -> Result<PlayTracksPlan, AppError> {
    if track_ids.is_empty() {
        return Err(AppError::Other(
            "At least one track ID is required".to_string(),
        ));
    }
    if start_index >= track_ids.len() {
        return Err(AppError::Other(format!(
            "start_index {start_index} is out of bounds for {} tracks",
            track_ids.len()
        )));
    }

    let tracks = resolve_queue_tracks(db, track_ids)?;
    Ok(PlayTracksPlan {
        tracks,
        start_index,
        shuffle,
    })
}

#[cfg(test)]
fn validate_prepare_and_apply_play_tracks<T, Prepared>(
    db: &Database,
    track_ids: &[String],
    start_index: usize,
    shuffle: bool,
    prepare: impl FnOnce(&str) -> Result<Prepared, String>,
    apply: impl FnOnce(PlayTracksPlan, Prepared) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let plan = validate_play_tracks(db, track_ids, start_index, shuffle)?;
    let track_path = &plan.tracks[plan.start_index].file_path;
    let prepared = prepare(track_path).map_err(AppError::Other)?;
    apply(plan, prepared)
}

fn validate_and_prepare_play_tracks<Prepared>(
    db: &Database,
    track_ids: &[String],
    start_index: usize,
    shuffle: bool,
    prepare: impl FnOnce(&str) -> Result<Prepared, String>,
) -> Result<(String, Prepared), AppError> {
    let plan = validate_play_tracks(db, track_ids, start_index, shuffle)?;
    let track_path = plan.tracks[plan.start_index].file_path.clone();
    let prepared = prepare(&track_path).map_err(AppError::Other)?;
    Ok((track_path, prepared))
}

fn prepare_then_apply_play_tracks<T, Prepared>(
    db: &Database,
    track_ids: &[String],
    start_index: usize,
    shuffle: bool,
    prepare: impl FnOnce(&str) -> Result<Prepared, String>,
    apply: impl FnOnce(String, Prepared) -> Result<T, AppError>,
) -> Result<T, AppError> {
    let (path, prepared) =
        validate_and_prepare_play_tracks(db, track_ids, start_index, shuffle, prepare)?;
    apply(path, prepared)
}

fn serialized_prepare_then_apply_play_tracks<T, Prepared>(
    db: &Database,
    track_ids: &[String],
    start_index: usize,
    shuffle: bool,
    prepare: impl FnOnce(&str) -> Result<Prepared, String>,
    apply: impl FnOnce(String, Prepared) -> Result<T, AppError>,
) -> Result<T, AppError> {
    // Include lookup and source preparation in the same transition as commit so
    // a competing queue cursor change cannot alter the selected item mid-load.
    // Database queries take only their internal reader guard; no DB guard is
    // held while decoder preparation runs.
    let _transition = lock_playback_transition()?;
    prepare_then_apply_play_tracks(db, track_ids, start_index, shuffle, prepare, apply)
}

fn replace_queue_for_play_tracks(queue: &mut PlaybackQueue, plan: PlayTracksPlan) {
    // Select the requested current track in the input order before shuffle
    // changes only the order of the upcoming tracks.
    queue.set_shuffle(false);
    queue.replace(plan.tracks);
    let _ = queue.jump_to(plan.start_index);
    if plan.shuffle {
        queue.shuffle_upcoming_from_current();
    }
}

fn apply_play_tracks_after_handoff(
    queue: &mut PlaybackQueue,
    plan: PlayTracksPlan,
    enqueue: impl FnOnce(&Track) -> Result<(), AppError>,
) -> Result<QueuePayload, AppError> {
    let selected = &plan.tracks[plan.start_index];
    enqueue(selected)?;
    replace_queue_for_play_tracks(queue, plan);
    Ok(QueuePayload {
        tracks: queue.get_play_order_tracks(),
        current_index: queue.get_current_index(),
    })
}

static PLAYBACK_TRANSITION_LOCK: Mutex<()> = Mutex::new(());

// This serializes authoritative track and queue mutations with sibling
// commands. `play_tracks` holds this transition lock through preparation and
// commit, while each database operation releases its internal reader/writer
// guard before decoder preparation or queue mutation.
fn lock_playback_transition() -> Result<MutexGuard<'static, ()>, AppError> {
    PLAYBACK_TRANSITION_LOCK
        .lock()
        .map_err(|error| AppError::Other(error.to_string()))
}

async fn run_playback_blocking<T>(task: impl FnOnce() -> T + Send + 'static) -> Result<T, AppError>
where
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|error| AppError::Other(format!("Playback worker failed: {error}")))
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
#[specta::specta]
pub async fn play_track(track_id: String, app: tauri::AppHandle) -> Result<(), AppError> {
    run_playback_blocking(move || {
        let player = app.state::<AudioPlayer>();
        let queue = app.state::<QueueState>();
        let db = app.state::<Database>();

        let prepared = prepare_playback_track(&db, &track_id)?;
        let path = prepared.track.file_path.clone();
        let prepared_source = crate::audio::decoder::open_track(&path).map_err(AppError::Other)?;
        let _transition = lock_playback_transition()?;
        let track = resolve_queue_track(&db, &track_id)?;
        if track.file_path != path {
            return Err(AppError::Other(
                "Track location changed while audio was being prepared; retry playback".to_string(),
            ));
        }
        let track_eq_override = track_eq_override_for_play(&db, &track_id);
        let queue_payload = {
            let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
            player
                .load_prepared_track(&path, track.clone(), prepared_source, track_eq_override)
                .map_err(AppError::Other)?;
            q.play_now(track.clone());
            queue_changed_payload(&q)
        };
        emit_queue_payload_changed(&app, &queue_payload);
        record_play(&app.state::<PlayHistoryWriter>(), &track_id, "play_track");
        Ok(())
    })
    .await?
}

/// Replace the queue and start a selected library track in one validated operation.
/// IDs retain their supplied order; `start_index` is zero-based. When shuffle
/// is enabled, the selected track stays current and only upcoming tracks shuffle.
/// Frontend: `invoke('play_tracks', { trackIds, startIndex, shuffle })`
#[tauri::command]
#[specta::specta]
pub async fn play_tracks(
    track_ids: Vec<String>,
    start_index: usize,
    shuffle: bool,
    app: tauri::AppHandle,
) -> Result<(), AppError> {
    run_playback_blocking(move || {
        let player = app.state::<AudioPlayer>();
        let queue = app.state::<QueueState>();
        let db = app.state::<Database>();

        serialized_prepare_then_apply_play_tracks(
            &db,
            &track_ids,
            start_index,
            shuffle,
            crate::audio::decoder::open_track,
            |prepared_path, prepared_source| {
                let plan = validate_play_tracks(&db, &track_ids, start_index, shuffle)?;
                let selected = &plan.tracks[plan.start_index];
                if selected.file_path != prepared_path {
                    return Err(AppError::Other(
                        "Selected track changed while audio was being prepared; retry playback"
                            .to_string(),
                    ));
                }
                let track_eq_override = track_eq_override_for_play(&db, &selected.id);
                let track = plan.tracks[plan.start_index].clone();
                let track_id = track.id.clone();
                let path = track.file_path.clone();
                let mut queue = queue
                    .0
                    .lock()
                    .map_err(|error| AppError::Other(error.to_string()))?;
                let payload = apply_play_tracks_after_handoff(&mut queue, plan, |selected| {
                    player
                        .load_prepared_track(
                            &path,
                            selected.clone(),
                            prepared_source,
                            track_eq_override,
                        )
                        .map_err(AppError::Other)
                })?;
                drop(queue);

                record_play(&app.state::<PlayHistoryWriter>(), &track_id, "play_tracks");
                emit_queue_payload_changed(&app, &payload);
                Ok(())
            },
        )
    })
    .await?
}

// Called by the dedicated OpenFilesWorker in lib.rs; keep file association and
// startup-open metadata extraction and decoder probing off the IPC thread.
pub fn open_audio_files(app: &AppHandle, paths: Vec<PathBuf>) -> Result<(), AppError> {
    let db = app.state::<Database>();
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

        let existing = db.get_track_by_path(&path).map_err(AppError::from)?;
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

    let player = app.state::<AudioPlayer>();
    let path = first.file_path.clone();
    let prepared_source = crate::audio::decoder::open_track(&path).map_err(AppError::Other)?;
    let track_eq_override = if first_is_indexed {
        track_eq_override_for_play(&db, &first.id)
    } else {
        None
    };
    let _transition = lock_playback_transition()?;
    let queue = app.state::<QueueState>();
    let queue_payload = {
        let mut queue = queue
            .0
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        player
            .load_prepared_track(&path, first.clone(), prepared_source, track_eq_override)
            .map_err(AppError::Other)?;
        queue.clear();
        queue.add_many(tracks.into_iter().map(|(track, _)| track).collect());
        queue_changed_payload(&queue)
    };
    emit_queue_payload_changed(app, &queue_payload);

    if first_is_indexed {
        record_play(
            &app.state::<PlayHistoryWriter>(),
            &first.id,
            "open_audio_files",
        );
    }
    Ok(())
}

/// Pause the current playback.
/// Frontend: `invoke('pause')`
#[tauri::command]
#[specta::specta]
pub fn pause(player: State<'_, AudioPlayer>) {
    player.pause();
}

/// Resume playback after pausing.
/// Frontend: `invoke('resume')`
#[tauri::command]
#[specta::specta]
pub fn resume(player: State<'_, AudioPlayer>) {
    player.resume();
}

/// Stop playback and clear the current track.
/// Frontend: `invoke('stop')`
#[tauri::command]
#[specta::specta]
pub fn stop(player: State<'_, AudioPlayer>) {
    player.stop();
}

/// Seek to a specific position in the current track.
/// Frontend: `invoke('seek', { positionSecs: 30.5 })`
///
/// # Arguments
/// * `position_secs` — position in seconds to seek to
#[tauri::command]
#[specta::specta]
pub fn seek(position_secs: f64, player: State<'_, AudioPlayer>) {
    player.seek(position_secs);
}

/// Set the playback volume.
/// Frontend: `invoke('set_volume', { volume: 0.75 })`
///
/// # Arguments
/// * `volume` — volume level from 0.0 (mute) to 1.0 (full volume)
#[tauri::command]
#[specta::specta]
pub fn set_volume(
    volume: f32,
    player: State<'_, AudioPlayer>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    let _controls = preferences.lock_controls().map_err(AppError::Other)?;
    preferences.ensure_initialized().map_err(AppError::Other)?;
    player.set_volume(volume);
    Ok(())
}

fn initialize_runtime_preferences(
    preferences: &PlaybackPreferencesStore,
    legacy: Option<PlaybackPreferences>,
    apply_runtime: impl FnOnce(&PlaybackPreferences) -> Result<(), String>,
) -> Result<(), String> {
    // Keep control admission and other initializers serialized until both
    // player volume and queue modes have received the same saved snapshot.
    let _controls = preferences.lock_controls()?;
    let (restored, should_apply) = preferences.initialize(legacy)?;
    if should_apply {
        apply_runtime(&restored)?;
        preferences.mark_runtime_ready()?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn initialize_playback_preferences(
    legacy: Option<PlaybackPreferences>,
    app: AppHandle,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    initialize_runtime_preferences(&preferences, legacy, |restored| {
        player.restore_volume_preferences(restored)?;
        let mut q = queue.0.lock().map_err(|error| error.to_string())?;
        q.set_shuffle(restored.shuffle);
        q.set_repeat_mode(RepeatMode::from_str(&restored.repeat_mode));
        Ok(())
    })
    .map_err(AppError::Other)?;
    emit_current_playback_state(&app, &player, &queue);
    Ok(())
}

/// What a metadata refresh changed, so the caller decides which events to emit.
struct MetadataRefresh {
    player_changed: bool,
    queue_payload: Option<QueuePayload>,
}

/// Re-reads the rows for tracks held by the player or queue and applies them to both.
/// Kept free of Tauri handles so tests can drive rows written by a rescan through this path.
fn refresh_playback_metadata_from_database(
    db: &Database,
    player: &AudioPlayer,
    queue: &QueueState,
) -> Result<MetadataRefresh, AppError> {
    let mut track_ids = player.metadata_track_ids();
    {
        let q = queue
            .0
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        track_ids.extend(q.get_tracks().iter().map(|track| track.id.clone()));
    }
    track_ids.sort_unstable();
    track_ids.dedup();
    if track_ids.is_empty() {
        return Ok(MetadataRefresh {
            player_changed: false,
            queue_payload: None,
        });
    }

    let tracks = db
        .get_tracks_by_ids(&track_ids)
        .map_err(AppError::from)?
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();

    let player_changed = player.refresh_track_metadata(&tracks);
    let queue_payload = {
        let mut q = queue
            .0
            .lock()
            .map_err(|error| AppError::Other(error.to_string()))?;
        q.refresh_track_metadata(&tracks).then(|| QueuePayload {
            tracks: q.get_play_order_tracks(),
            current_index: q.get_current_index(),
        })
    };
    Ok(MetadataRefresh {
        player_changed,
        queue_payload,
    })
}

#[tauri::command]
#[specta::specta]
pub fn refresh_playback_metadata(
    app: AppHandle,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let refresh = refresh_playback_metadata_from_database(&db, &player, &queue)?;
    let queue_changed = refresh.queue_payload.is_some();
    if let Some(payload) = refresh.queue_payload {
        emit_queue_payload(&app, &payload);
    }
    if refresh.player_changed || queue_changed {
        emit_current_playback_state(&app, &player, &queue);
    }
    Ok(())
}

#[cfg(test)]
mod metadata_refresh_tests {
    use super::refresh_playback_metadata_from_database;
    use crate::audio::player::AudioPlayer;
    use crate::audio::preferences::PlaybackPreferencesStore;
    use crate::audio::queue::{PlaybackQueue, QueueState};
    use crate::library::database::Database;
    use crate::models::Track;
    use std::sync::Mutex;

    fn track(id: &str, title: &str) -> Track {
        Track {
            id: id.to_string(),
            title: title.to_string(),
            artist: "Artist".to_string(),
            album: "Album".to_string(),
            album_artist: "Artist".to_string(),
            genre: "Genre".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 180.0,
            file_path: format!("/music/{id}.mp3"),
            file_size: 1024,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn rescan_rows_reach_the_playback_snapshot_without_resetting_progress() {
        let base =
            std::env::temp_dir().join(format!("viby-metadata-refresh-{}", uuid::Uuid::new_v4()));
        let db_path = base.with_extension("db");
        let prefs_path = base.with_extension("json");
        let db = Database::open(&db_path).expect("open library database");
        let original = track("t1", "Old title");
        db.upsert_track(&original).expect("seed library row");

        let preferences = PlaybackPreferencesStore::open(&prefs_path);
        let (player, _commands) = AudioPlayer::new_without_audio_thread(&preferences);
        player.seed_current_track_for_tests(original.clone(), 42.0);
        let queue = QueueState(Mutex::new(PlaybackQueue::new()));
        queue.0.lock().expect("queue lock").add(original);

        // A rescan writes the corrected row through the same batch path the scan uses.
        db.upsert_tracks_batch(&[track("t1", "New title")])
            .expect("rescan writes library row");

        let refresh =
            refresh_playback_metadata_from_database(&db, &player, &queue).expect("refresh");
        assert!(refresh.player_changed);
        let payload = refresh
            .queue_payload
            .expect("queue payload after metadata change");
        assert_eq!(payload.tracks[0].title, "New title");

        let snapshot = player.get_state();
        let current = snapshot.current_track.expect("current track in snapshot");
        assert_eq!(current.title, "New title");
        assert_eq!(snapshot.position_secs, 42.0);

        let again = refresh_playback_metadata_from_database(&db, &player, &queue).expect("refresh");
        assert!(!again.player_changed);
        assert!(again.queue_payload.is_none());

        drop(db);
        for path in [
            db_path.clone(),
            db_path.with_extension("db-wal"),
            db_path.with_extension("db-shm"),
            prefs_path,
        ] {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tauri::command]
#[specta::specta]
pub fn toggle_mute(
    player: State<'_, AudioPlayer>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    let _controls = preferences.lock_controls().map_err(AppError::Other)?;
    preferences.ensure_initialized().map_err(AppError::Other)?;
    player.toggle_mute();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn set_sound_check_enabled(enabled: bool, player: State<'_, AudioPlayer>) {
    player.set_sound_check_enabled(enabled);
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
pub fn get_track_eq_override(
    track_id: String,
    db: State<'_, Database>,
) -> Result<Option<TrackEqOverride>, AppError> {
    db.get_track_eq_override(&track_id).map_err(AppError::from)
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
pub fn clear_track_eq_override(player: State<'_, AudioPlayer>) {
    player.clear_track_eq_override();
}

#[tauri::command]
#[specta::specta]
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
#[derive(Clone, Copy, serde::Deserialize, specta::Type)]
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
#[specta::specta]
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

#[derive(serde::Deserialize, specta::Type)]
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
#[specta::specta]
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
#[specta::specta]
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
#[specta::specta]
pub fn set_eq_topology(mode: u8, player: State<'_, AudioPlayer>) {
    player.set_eq_topology(mode);
}

/// Export current PEQ to a standard format string.
/// Supported formats: "apo", "camilladsp", "easyeffects", "pipewire", "roon", "wavelet"
/// Frontend: `const config = await invoke('export_peq', { format: 'apo' })`
#[tauri::command]
#[specta::specta]
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
    db: &Database,
) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let started = Instant::now();
    let (next, payload) = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let previous_queue = q.clone();
        let next = q.next(user_initiated).cloned();
        if let Some(track) = &next {
            let path = track.file_path.clone();
            let track_eq_override = track_eq_override_for_play(db, &track.id);
            if let Err(error) =
                player.load_track_with_eq_override(&path, track.clone(), track_eq_override)
            {
                *q = previous_queue;
                return Err(AppError::Other(error));
            }
        }
        (next, queue_position_payload(&q))
    };
    emit_queue_position_changed(app, &payload);

    if let Some(track) = next {
        record_play(&app.state::<PlayHistoryWriter>(), &track.id, "next_track");
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
#[specta::specta]
pub fn next_track(
    app: tauri::AppHandle,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    advance_to_next(&app, user_initiated.unwrap_or(true), &player, &queue, &db)
}

/// Go back to the previous track in the queue.
/// Frontend: `invoke('previous_track', { userInitiated: true })`
#[tauri::command]
#[specta::specta]
pub fn previous_track(
    app: tauri::AppHandle,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let started = Instant::now();
    let is_user = user_initiated.unwrap_or(true);
    let (previous, payload) = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let previous_queue = q.clone();
        let before = q.get_current_index();
        let previous = q.previous(is_user).cloned();
        if let Some(track) = &previous {
            let path = track.file_path.clone();
            let track_eq_override = track_eq_override_for_play(&db, &track.id);
            if let Err(error) =
                player.load_track_with_eq_override(&path, track.clone(), track_eq_override)
            {
                *q = previous_queue;
                return Err(AppError::Other(error));
            }
        }
        let payload = (previous.is_some() || q.get_current_index() != before)
            .then(|| queue_position_payload(&q));
        (previous, payload)
    };
    if let Some(payload) = payload {
        emit_queue_position_changed(&app, &payload);
    }

    if let Some(track) = previous {
        record_play(
            &app.state::<PlayHistoryWriter>(),
            &track.id,
            "previous_track",
        );
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
#[specta::specta]
pub fn skip_tracks(
    app: tauri::AppHandle,
    delta: i32,
    user_initiated: Option<bool>,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
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

    let _transition = lock_playback_transition()?;
    let (selected, payload) = {
        debug_log_event("skip_tracks", "Locking queue");
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let previous_queue = q.clone();
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

        if let Some(track) = &selected {
            let path = track.file_path.clone();
            let track_eq_override = track_eq_override_for_play(&db, &track.id);
            if let Err(error) =
                player.load_track_with_eq_override(&path, track.clone(), track_eq_override)
            {
                *q = previous_queue;
                return Err(AppError::Other(error));
            }
        } else if delta > 0 {
            player.stop();
        }

        debug_log_event("skip_tracks", "Emitting queue position");
        (selected, queue_position_payload(&q))
    };
    emit_queue_position_changed(&app, &payload);

    if let Some(track) = selected {
        let path = track.file_path.clone();
        debug_log_event(
            "skip_tracks",
            &format!("Selected track: id={}, title={}", track.id, track.title),
        );
        record_play(&app.state::<PlayHistoryWriter>(), &track.id, "skip_tracks");
        debug_log_event("skip_tracks", &format!("Loading track: path={}", path));
        debug_log_event("skip_tracks", "load_track called on player state");
    } else if delta > 0 {
        debug_log_event("skip_tracks", "No track selected; stopping player");
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
#[specta::specta]
pub fn set_shuffle(
    app: tauri::AppHandle,
    enabled: bool,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    let _controls = preferences.lock_controls().map_err(AppError::Other)?;
    preferences.ensure_initialized().map_err(AppError::Other)?;
    let _transition = lock_playback_transition()?;
    let payload = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        q.set_shuffle(enabled);
        preferences.set_shuffle(enabled);
        queue_changed_payload(&q)
    };
    emit_queue_payload(&app, &payload);
    emit_current_playback_state(&app, &player, &queue);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn toggle_shuffle(
    app: AppHandle,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    let _controls = preferences.lock_controls().map_err(AppError::Other)?;
    preferences.ensure_initialized().map_err(AppError::Other)?;
    let _transition = lock_playback_transition()?;
    let payload = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let enabled = !q.is_shuffle();
        q.set_shuffle(enabled);
        preferences.set_shuffle(enabled);
        queue_changed_payload(&q)
    };
    emit_queue_payload(&app, &payload);
    emit_current_playback_state(&app, &player, &queue);
    Ok(())
}

/// Set the repeat mode.
/// Frontend: `invoke('set_repeat', { mode: 'all' })`
///
/// # Arguments
/// * `mode` — one of: "off", "one", "all"
#[tauri::command]
#[specta::specta]
pub fn set_repeat(
    app: tauri::AppHandle,
    mode: RepeatMode,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    let _controls = preferences.lock_controls().map_err(AppError::Other)?;
    preferences.ensure_initialized().map_err(AppError::Other)?;
    let _transition = lock_playback_transition()?;
    let payload = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        q.set_repeat_mode(mode);
        preferences.set_repeat_mode(mode.as_str());
        queue_changed_payload(&q)
    };
    emit_queue_payload(&app, &payload);
    emit_current_playback_state(&app, &player, &queue);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn cycle_repeat(
    app: AppHandle,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    preferences: State<'_, PlaybackPreferencesStore>,
) -> Result<(), AppError> {
    let _controls = preferences.lock_controls().map_err(AppError::Other)?;
    preferences.ensure_initialized().map_err(AppError::Other)?;
    let _transition = lock_playback_transition()?;
    let payload = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let next_mode = next_repeat_mode(q.get_repeat_mode());
        q.set_repeat_mode(next_mode);
        preferences.set_repeat_mode(next_mode.as_str());
        QueuePayload {
            tracks: q.get_play_order_tracks(),
            current_index: q.get_current_index(),
        }
    };
    emit_queue_payload(&app, &payload);
    emit_current_playback_state(&app, &player, &queue);
    Ok(())
}

fn next_repeat_mode(mode: RepeatMode) -> RepeatMode {
    match mode {
        RepeatMode::Off => RepeatMode::All,
        RepeatMode::All => RepeatMode::One,
        RepeatMode::One => RepeatMode::Off,
    }
}

fn emit_queue_payload(app: &AppHandle, payload: &QueuePayload) {
    emit_queue_payload_changed(app, payload);
}

fn emit_current_playback_state(app: &AppHandle, player: &AudioPlayer, queue: &QueueState) {
    let mut state = player.get_state_for_event();
    if let Ok(q) = queue.0.lock() {
        state.shuffle = q.is_shuffle();
        state.repeat_mode = q.get_repeat_mode();
    }
    if let Err(error) = app.emit("playback-state", &state) {
        eprintln!("[PlaybackCommand] Failed to emit playback-state: {error}");
    }
}

/// Get the current playback state (what's playing, position, volume, etc.).
/// Frontend: `const state = await invoke('get_playback_state')`
///
/// This is a "pull" alternative to the "push" events emitted by the player.
/// Use events for real-time updates, and this command for initial state.
#[tauri::command]
#[specta::specta]
pub fn get_playback_state(
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
) -> PlaybackState {
    let mut state = player.get_state_for_event();

    // Overlay queue state (shuffle & repeat) onto the playback state
    if let Ok(q) = queue.0.lock() {
        state.shuffle = q.is_shuffle();
        state.repeat_mode = q.get_repeat_mode();
    }

    state
}

// =============================================================================
// Queue management commands
// =============================================================================

#[tauri::command]
#[specta::specta]
pub fn get_queue(queue: State<'_, QueueState>) -> Result<QueuePayload, AppError> {
    let q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
    Ok(queue_changed_payload(&q))
}

#[tauri::command]
#[specta::specta]
pub fn add_to_queue(
    app: tauri::AppHandle,
    track_id: String,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let track = resolve_queue_track(&db, &track_id)?;
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, |q| q.add(track))?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn add_to_queue_next(
    app: tauri::AppHandle,
    track_id: String,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let track = resolve_queue_track(&db, &track_id)?;
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, |q| q.add_next(track))?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn add_tracks_to_queue(
    app: tauri::AppHandle,
    track_ids: Vec<String>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let tracks = resolve_queue_tracks(&db, &track_ids)?;
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, |q| q.add_many(tracks))?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn add_tracks_to_queue_next(
    app: tauri::AppHandle,
    track_ids: Vec<String>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let tracks = resolve_queue_tracks(&db, &track_ids)?;
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, |q| q.add_many_next(tracks))?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn remove_from_queue(
    app: tauri::AppHandle,
    index: usize,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, |q| q.remove(index))?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn reorder_queue(
    app: tauri::AppHandle,
    from: usize,
    to: usize,
    queue: State<'_, QueueState>,
) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, |q| q.move_item(from, to))?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_all(app: tauri::AppHandle, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, PlaybackQueue::clear_keeping_current)?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_up_next(app: tauri::AppHandle, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, PlaybackQueue::clear_up_next)?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn clear_history(app: tauri::AppHandle, queue: State<'_, QueueState>) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let (_, payload) = mutate_queue(&queue, PlaybackQueue::clear_history)?;
    emit_queue_payload_changed(&app, &payload);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn play_queue_index(
    app: tauri::AppHandle,
    index: usize,
    player: State<'_, AudioPlayer>,
    queue: State<'_, QueueState>,
    db: State<'_, Database>,
) -> Result<(), AppError> {
    let _transition = lock_playback_transition()?;
    let (selected, payload) = {
        let mut q = queue.0.lock().map_err(|e| AppError::Other(e.to_string()))?;
        let previous_queue = q.clone();
        let selected = q.jump_to(index).cloned();
        if let Some(track) = &selected {
            let path = track.file_path.clone();
            let track_eq_override = track_eq_override_for_play(&db, &track.id);
            if let Err(error) =
                player.load_track_with_eq_override(&path, track.clone(), track_eq_override)
            {
                *q = previous_queue;
                return Err(AppError::Other(error));
            }
        }
        let payload = selected.as_ref().map(|_| queue_position_payload(&q));
        (selected, payload)
    };
    if let Some(payload) = payload {
        emit_queue_position_changed(&app, &payload);
    }

    if let Some(track) = selected {
        record_play(
            &app.state::<PlayHistoryWriter>(),
            &track.id,
            "play_queue_index",
        );
    }

    Ok(())
}

#[tauri::command]
#[specta::specta]
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
#[specta::specta]
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

#[cfg(test)]
mod queue_id_tests {
    use super::{AppError, resolve_queue_track, resolve_queue_tracks};
    use crate::library::database::Database;
    use crate::models::Track;

    fn sample_track(id: &str, file_path: &str) -> Track {
        Track {
            id: id.to_string(),
            title: format!("Track {id}"),
            artist: "Test Artist".to_string(),
            album: "Test Album".to_string(),
            album_artist: "Test Artist".to_string(),
            genre: "Rock".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 200.0,
            file_path: file_path.to_string(),
            file_size: 2048,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn resolves_requested_ids_from_the_database_in_order() {
        let db = Database::open(":memory:").expect("in-memory database");
        db.upsert_track(&sample_track("a", "/library/a.flac"))
            .unwrap();
        db.upsert_track(&sample_track("b", "/library/b.flac"))
            .unwrap();

        let single = resolve_queue_track(&db, "a").expect("single ID exists");
        assert_eq!(single.file_path, "/library/a.flac");

        let tracks = resolve_queue_tracks(&db, &["b".into(), "a".into(), "b".into()])
            .expect("all IDs exist");

        assert_eq!(
            tracks
                .iter()
                .map(|track| track.id.as_str())
                .collect::<Vec<_>>(),
            ["b", "a", "b"]
        );
        assert_eq!(tracks[0].file_path, "/library/b.flac");
    }

    #[test]
    fn unknown_track_id_returns_a_clear_not_found_error() {
        let db = Database::open(":memory:").expect("in-memory database");

        let error = resolve_queue_track(&db, "missing").unwrap_err();

        assert!(matches!(
            error,
            AppError::NotFound(message) if message == "Track 'missing' not found in library"
        ));
    }
}

#[cfg(test)]
mod play_tracks_tests {
    use super::{
        AppError, PLAYBACK_TRANSITION_LOCK, PlaybackQueue, apply_play_tracks_after_handoff,
        lock_playback_transition, prepare_then_apply_play_tracks, replace_queue_for_play_tracks,
        run_playback_blocking, serialized_prepare_then_apply_play_tracks,
        validate_and_prepare_play_tracks, validate_play_tracks,
        validate_prepare_and_apply_play_tracks,
    };
    use crate::audio::player::AudioPlayerInner;
    use crate::library::database::Database;
    use crate::models::{Track, TrackEqOverride};
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    fn sample_track(id: &str) -> Track {
        Track {
            id: id.to_string(),
            title: format!("Track {id}"),
            artist: "Test Artist".to_string(),
            album: "Test Album".to_string(),
            album_artist: "Test Artist".to_string(),
            genre: "Rock".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 200.0,
            file_path: format!("/library/{id}.flac"),
            file_size: 2048,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    fn database_with_tracks(ids: &[&str]) -> Database {
        let db = Database::open(":memory:").expect("in-memory database");
        for id in ids {
            db.upsert_track(&sample_track(id)).unwrap();
        }
        db
    }

    #[test]
    fn decoder_preparation_runs_after_database_resolution() {
        let db = database_with_tracks(&["a"]);
        let ids = ["a".to_string()];

        let (path, prepared) = validate_and_prepare_play_tracks(&db, &ids, 0, false, |path| {
            assert!(db.get_track("a").unwrap().is_some());
            Ok(path.to_string())
        })
        .expect("track should validate and prepare");

        assert_eq!(path, "/library/a.flac");
        assert_eq!(prepared, path);
        assert!(db.get_track("a").unwrap().is_some());
    }

    #[test]
    fn blocked_preparation_offload_leaves_async_executor_responsive() {
        let (prepare_started_tx, prepare_started_rx) = mpsc::channel();
        let (finish_prepare_tx, finish_prepare_rx) = mpsc::channel();

        tauri::async_runtime::block_on(async move {
            let preparation = tauri::async_runtime::spawn(async move {
                run_playback_blocking(move || {
                    prepare_started_tx
                        .send(thread::current().id())
                        .expect("test should observe off-thread preparation");
                    finish_prepare_rx
                        .recv_timeout(Duration::from_secs(2))
                        .expect("test should release the simulated blocking preparation");
                })
                .await
            });

            let preparation_thread = prepare_started_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("preparation should start on the blocking pool");
            assert_ne!(preparation_thread, thread::current().id());

            let (responsive_action_tx, responsive_action_rx) = mpsc::channel();
            let responsive_action = tauri::async_runtime::spawn(async move {
                responsive_action_tx
                    .send(())
                    .expect("test should observe another async action");
            });
            responsive_action_rx
                .recv_timeout(Duration::from_secs(2))
                .expect("another async action should run while preparation is blocked");

            finish_prepare_tx
                .send(())
                .expect("preparation worker should still be waiting");
            responsive_action
                .await
                .expect("responsive async action should finish");
            preparation
                .await
                .expect("playback command future should finish")
                .expect("blocking preparation should complete");
        });
    }

    #[test]
    fn queue_transition_waits_until_play_tracks_preparation_and_commit_finish() {
        let db = Arc::new(database_with_tracks(&["new-a", "new-b"]));
        let ids = vec!["new-a".to_string(), "new-b".to_string()];
        let mut initial_queue = PlaybackQueue::new();
        initial_queue.add(sample_track("old-a"));
        initial_queue.add(sample_track("old-b"));
        let queue = Arc::new(Mutex::new(initial_queue));
        let (prepare_started_tx, prepare_started_rx) = mpsc::channel();
        let (finish_prepare_tx, finish_prepare_rx) = mpsc::channel();
        let (queue_waiting_tx, queue_waiting_rx) = mpsc::channel();
        let (order_tx, order_rx) = mpsc::channel();

        let playback_db = Arc::clone(&db);
        let playback_queue = Arc::clone(&queue);
        let playback_order = order_tx.clone();
        let playback = thread::spawn(move || {
            serialized_prepare_then_apply_play_tracks(
                &playback_db,
                &ids,
                0,
                false,
                |path| {
                    assert_eq!(path, "/library/new-a.flac");
                    assert!(playback_db.get_track("new-a").unwrap().is_some());
                    assert_eq!(
                        playback_queue
                            .lock()
                            .unwrap()
                            .current()
                            .map(|track| track.id.as_str()),
                        Some("old-a")
                    );
                    prepare_started_tx.send(()).unwrap();
                    finish_prepare_rx
                        .recv_timeout(Duration::from_secs(2))
                        .expect("test should release decoder preparation");
                    Ok(path.to_string())
                },
                |_, _| {
                    let plan = super::validate_play_tracks(&playback_db, &ids, 0, false).unwrap();
                    let mut queue = playback_queue.lock().unwrap();
                    apply_play_tracks_after_handoff(&mut queue, plan, |_| Ok(()))?;
                    assert_eq!(
                        queue.current().map(|track| track.id.as_str()),
                        Some("new-a")
                    );
                    playback_order.send("play_tracks_commit").unwrap();
                    Ok(())
                },
            )
            .expect("serialized play_tracks should finish");
        });

        prepare_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("play_tracks should enter decoder preparation");

        let queue_order = order_tx;
        let competing_queue = Arc::clone(&queue);
        let queue_mutation = thread::spawn(move || {
            assert!(PLAYBACK_TRANSITION_LOCK.try_lock().is_err());
            queue_waiting_tx.send(()).unwrap();
            let _transition = lock_playback_transition().unwrap();
            let mut queue = competing_queue.lock().unwrap();
            let selected = queue.jump_to(1).expect("second track should exist");
            assert_eq!(selected.id, "new-b");
            queue_order.send("queue_cursor_change").unwrap();
        });
        queue_waiting_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("queue transition should start while decoder preparation is blocked");
        assert_eq!(
            queue
                .lock()
                .unwrap()
                .current()
                .map(|track| track.id.as_str()),
            Some("old-a")
        );
        assert!(order_rx.try_recv().is_err());

        finish_prepare_tx.send(()).unwrap();
        playback.join().unwrap();
        queue_mutation.join().unwrap();

        assert_eq!(order_rx.recv().unwrap(), "play_tracks_commit");
        assert_eq!(order_rx.recv().unwrap(), "queue_cursor_change");
        assert_eq!(
            queue
                .lock()
                .unwrap()
                .current()
                .map(|track| track.id.as_str()),
            Some("new-b")
        );
    }

    #[test]
    fn production_preparation_failure_returns_before_queue_commit() {
        let db = database_with_tracks(&["new-a", "new-b"]);
        let ids = ["new-a".to_string(), "new-b".to_string()];
        let mut queue = PlaybackQueue::new();
        queue.add(sample_track("old-a"));
        queue.add(sample_track("old-b"));
        queue.jump_to(1);
        let original_order: Vec<_> = queue
            .get_play_order_tracks()
            .iter()
            .map(|track| track.id.clone())
            .collect();
        let original_current = queue.current().map(|track| track.id.clone());

        let result = validate_and_prepare_play_tracks(&db, &ids, 1, true, |path| {
            assert_eq!(path, "/library/new-b.flac");
            Err::<(), _>("injected decoder initialization failure".to_string())
        });

        assert!(matches!(
            result,
            Err(AppError::Other(message))
                if message == "injected decoder initialization failure"
        ));
        assert_eq!(
            queue
                .get_play_order_tracks()
                .iter()
                .map(|track| track.id.clone())
                .collect::<Vec<_>>(),
            original_order
        );
        assert_eq!(
            queue.current().map(|track| track.id.clone()),
            original_current
        );
        assert!(!queue.is_shuffle());
    }

    #[test]
    fn rejects_empty_ids_and_out_of_bounds_start_before_apply() {
        let db = database_with_tracks(&["a"]);
        let mut apply_called = false;

        let empty = validate_prepare_and_apply_play_tracks(
            &db,
            &[],
            0,
            false,
            |_| {
                apply_called = true;
                Ok(())
            },
            |_, _| Ok(()),
        );
        assert!(matches!(
            empty,
            Err(AppError::Other(message)) if message == "At least one track ID is required"
        ));

        let ids = ["a".to_string()];
        let invalid_start = validate_prepare_and_apply_play_tracks(
            &db,
            &ids,
            1,
            true,
            |_| {
                apply_called = true;
                Ok(())
            },
            |_, _| Ok(()),
        );
        assert!(matches!(
            invalid_start,
            Err(AppError::Other(message)) if message == "start_index 1 is out of bounds for 1 tracks"
        ));
        assert!(!apply_called);
    }

    #[test]
    fn mixed_valid_and_missing_ids_leave_queue_and_playback_untouched() {
        let db = database_with_tracks(&["valid"]);
        let mut queue = PlaybackQueue::new();
        queue.add(sample_track("old-a"));
        queue.add(sample_track("old-b"));
        queue.jump_to(1);
        let original_order: Vec<_> = queue
            .get_play_order_tracks()
            .iter()
            .map(|track| track.id.clone())
            .collect();
        let original_current = queue.current().map(|track| track.id.clone());
        let mut playback_track = Some("old-b".to_string());
        let mut prepare_called = false;
        let mut apply_called = false;
        let requested = ["valid".to_string(), "missing".to_string()];

        let result = validate_prepare_and_apply_play_tracks(
            &db,
            &requested,
            0,
            true,
            |_| {
                prepare_called = true;
                Ok(())
            },
            |plan, _| {
                apply_called = true;
                let selected_id = plan.tracks[plan.start_index].id.clone();
                replace_queue_for_play_tracks(&mut queue, plan);
                playback_track = Some(selected_id);
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(AppError::NotFound(message))
                if message == "Track 'missing' not found in library"
        ));
        assert!(!prepare_called);
        assert!(!apply_called);
        assert_eq!(
            queue
                .get_play_order_tracks()
                .iter()
                .map(|track| track.id.clone())
                .collect::<Vec<_>>(),
            original_order
        );
        assert_eq!(
            queue.current().map(|track| track.id.clone()),
            original_current
        );
        assert!(!queue.is_shuffle());
        assert_eq!(playback_track.as_deref(), Some("old-b"));
    }

    #[test]
    fn failed_audio_preparation_leaves_queue_and_playback_side_effects_untouched() {
        let db = database_with_tracks(&["old-a", "old-b"]);
        let fixture_dir =
            std::env::temp_dir().join(format!("viby-corrupt-play-track-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&fixture_dir).unwrap();
        let corrupt_path = fixture_dir.join("corrupt.flac");
        std::fs::write(&corrupt_path, b"not an audio container").unwrap();
        let mut unavailable = sample_track("unavailable");
        unavailable.file_path = corrupt_path.to_string_lossy().into_owned();
        db.upsert_track(&unavailable).unwrap();
        db.record_play("old-b").unwrap();

        let mut queue = PlaybackQueue::new();
        queue.add(sample_track("old-a"));
        queue.add(sample_track("old-b"));
        queue.jump_to(1);
        let original_order: Vec<_> = queue
            .get_play_order_tracks()
            .iter()
            .map(|track| track.id.clone())
            .collect();
        let original_current = queue.current().map(|track| track.id.clone());
        let old_track = sample_track("old-b");
        let mut player_state = AudioPlayerInner {
            is_playing: true,
            current_track: Some(old_track.clone()),
            current_path: Some(old_track.file_path.clone()),
            queued_track: Some(sample_track("old-a")),
            queued_path: Some(sample_track("old-a").file_path),
            position_secs: 14.0,
            duration_secs: old_track.duration_secs,
            progress_generation: 7,
            progress_sequence: 11,
            volume: 0.55,
            is_muted: false,
            previous_volume: 0.55,
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: Some(16),
            queued_sample_rate: Some(48_000),
            queued_channels: Some(2),
            queued_bits_per_sample: Some(16),
            output_sample_rate: Some(48_000),
            output_channels: Some(2),
            output_sample_format: Some("f32".to_string()),
            output_fallback_reason: None,
            seek_position_offset: 0.0,
            sink_baseline_secs: 0.0,
            seek_guard_until: Some(Instant::now()),
        };
        let mut current_eq = Some(TrackEqOverride {
            track_id: "old-b".to_string(),
            enabled: true,
            preamp_db: -2.0,
            gains: vec![0.5; 10],
            updated_at: "2024-01-01T00:00:00Z".to_string(),
        });
        let original_eq = current_eq.clone();
        let history_before = db
            .get_recently_played(10)
            .unwrap()
            .iter()
            .map(|track| track.id.clone())
            .collect::<Vec<_>>();
        let original_player_track = player_state.current_track.as_ref().unwrap().id.clone();
        let original_player_path = player_state.current_path.clone();
        let original_queued_track = player_state.queued_track.as_ref().unwrap().id.clone();
        let original_queued_path = player_state.queued_path.clone();
        let original_playing = player_state.is_playing;
        let original_position = player_state.position_secs;
        let original_duration = player_state.duration_secs;
        let original_volume = player_state.volume;
        let mut commit_called = false;
        let requested = ["unavailable".to_string()];

        let result = prepare_then_apply_play_tracks(
            &db,
            &requested,
            0,
            false,
            crate::audio::decoder::open_track,
            |prepared_path, _prepared_source| {
                let plan = validate_play_tracks(&db, &requested, 0, false).unwrap();
                assert_eq!(plan.tracks[plan.start_index].file_path, prepared_path);
                commit_called = true;
                player_state.current_track = Some(unavailable.clone());
                player_state.current_path = Some(unavailable.file_path.clone());
                player_state.is_playing = true;
                player_state.position_secs = 0.0;
                current_eq = None;
                replace_queue_for_play_tracks(&mut queue, plan);
                db.record_play("unavailable").unwrap();
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(AppError::Other(message)) if message.contains("Failed to decode")
        ));
        assert!(!commit_called);
        assert_eq!(
            queue
                .get_play_order_tracks()
                .iter()
                .map(|track| track.id.clone())
                .collect::<Vec<_>>(),
            original_order
        );
        assert_eq!(
            queue.current().map(|track| track.id.clone()),
            original_current
        );
        assert_eq!(
            player_state.current_track.as_ref().unwrap().id,
            original_player_track
        );
        assert_eq!(player_state.current_path, original_player_path);
        assert_eq!(
            player_state.queued_track.as_ref().unwrap().id,
            original_queued_track
        );
        assert_eq!(player_state.queued_path, original_queued_path);
        assert_eq!(player_state.is_playing, original_playing);
        assert_eq!(player_state.position_secs, original_position);
        assert_eq!(player_state.duration_secs, original_duration);
        assert_eq!(player_state.volume, original_volume);
        assert_eq!(
            serde_json::to_value(&current_eq).unwrap(),
            serde_json::to_value(&original_eq).unwrap()
        );
        assert_eq!(
            db.get_recently_played(10)
                .unwrap()
                .iter()
                .map(|track| track.id.clone())
                .collect::<Vec<_>>(),
            history_before
        );
        std::fs::remove_dir_all(fixture_dir).unwrap();
    }

    #[test]
    fn injected_audio_preparation_failure_keeps_the_previous_playback_transaction() {
        let db = database_with_tracks(&["new-a", "new-b"]);
        let ids = ["new-a".to_string(), "new-b".to_string()];
        let mut queue = PlaybackQueue::new();
        queue.add(sample_track("old-a"));
        queue.add(sample_track("old-b"));
        queue.jump_to(1);
        let original_order: Vec<_> = queue
            .get_play_order_tracks()
            .iter()
            .map(|track| track.id.clone())
            .collect();
        let original_current = queue.current().map(|track| track.id.clone());
        let mut playback_track = original_current.clone();
        let mut history_writes = 0;
        let mut eq_updates = 0;
        let mut queue_events = 0;

        let result = validate_prepare_and_apply_play_tracks(
            &db,
            &ids,
            1,
            true,
            |path| {
                assert_eq!(path, "/library/new-b.flac");
                Err::<(), _>("injected decoder initialization failure".to_string())
            },
            |plan, _prepared_source| {
                history_writes += 1;
                eq_updates += 1;
                replace_queue_for_play_tracks(&mut queue, plan);
                playback_track = queue.current().map(|track| track.id.clone());
                queue_events += 1;
                Ok(())
            },
        );

        assert!(matches!(
            result,
            Err(AppError::Other(message))
                if message == "injected decoder initialization failure"
        ));
        assert_eq!(
            queue
                .get_play_order_tracks()
                .iter()
                .map(|track| track.id.clone())
                .collect::<Vec<_>>(),
            original_order
        );
        assert_eq!(
            queue.current().map(|track| track.id.clone()),
            original_current
        );
        assert_eq!(playback_track, original_current);
        assert!(!queue.is_shuffle());
        assert_eq!(history_writes, 0);
        assert_eq!(eq_updates, 0);
        assert_eq!(queue_events, 0);
    }

    #[test]
    fn failed_audio_handoff_leaves_queue_untouched() {
        let db = database_with_tracks(&["new-a", "new-b"]);
        let ids = ["new-a".to_string(), "new-b".to_string()];
        let plan = validate_play_tracks(&db, &ids, 1, true).unwrap();
        let mut queue = PlaybackQueue::new();
        queue.add(sample_track("old-a"));
        queue.add(sample_track("old-b"));
        queue.jump_to(1);
        let original_order: Vec<_> = queue
            .get_play_order_tracks()
            .iter()
            .map(|track| track.id.clone())
            .collect();
        let original_current = queue.current().map(|track| track.id.clone());
        let result = apply_play_tracks_after_handoff(&mut queue, plan, |_| {
            Err(AppError::Other("audio thread is closed".into()))
        });

        assert!(
            matches!(result, Err(AppError::Other(message)) if message == "audio thread is closed")
        );
        assert_eq!(
            queue
                .get_play_order_tracks()
                .iter()
                .map(|track| track.id.clone())
                .collect::<Vec<_>>(),
            original_order
        );
        assert_eq!(
            queue.current().map(|track| track.id.clone()),
            original_current
        );
        assert!(!queue.is_shuffle());
    }

    #[test]
    fn shuffle_keeps_the_selected_track_current_and_order_mode_is_restorable() {
        let db = database_with_tracks(&["a", "b", "c", "d"]);
        let ids = ["a", "b", "c", "d"].map(String::from);
        let plan = validate_play_tracks(&db, &ids, 2, true).unwrap();
        let mut queue = PlaybackQueue::new();

        replace_queue_for_play_tracks(&mut queue, plan);

        assert!(queue.is_shuffle());
        assert_eq!(queue.get_current_index(), Some(0));
        assert_eq!(queue.current().map(|track| track.id.as_str()), Some("c"));
        let shuffled_order = queue.get_play_order_tracks();
        assert_eq!(shuffled_order[0].id, "c");
        let mut upcoming: Vec<_> = shuffled_order[1..]
            .iter()
            .map(|track| track.id.clone())
            .collect();
        upcoming.sort_unstable();
        assert_eq!(
            upcoming,
            vec!["a".to_string(), "b".to_string(), "d".to_string()]
        );

        queue.set_shuffle(false);
        assert!(!queue.is_shuffle());
        assert_eq!(queue.get_current_index(), Some(2));
        assert_eq!(queue.current().map(|track| track.id.as_str()), Some("c"));
    }
}

#[cfg(test)]
mod playback_start_contention_tests {
    use super::prepare_playback_track;
    use crate::audio::player::{AudioCommand, AudioPlayer};
    use crate::library::database::Database;
    use crate::library::play_history::PlayHistoryWriter;
    use crate::models::{Track, TrackEqOverride};
    use std::sync::{Arc, mpsc};
    use std::time::Duration;

    fn sample_track() -> Track {
        Track {
            id: "queued".to_string(),
            title: "Track queued".to_string(),
            artist: "Test Artist".to_string(),
            album: "Test Album".to_string(),
            album_artist: "Test Artist".to_string(),
            genre: "Rock".to_string(),
            year: Some(2024),
            track_number: Some(1),
            disc_number: Some(1),
            duration_secs: 200.0,
            file_path: "/music/queued.flac".to_string(),
            file_size: 2048,
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix: None,
            date_added: "2024-01-01T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn playback_start_and_seek_progress_while_scan_writer_is_held_then_flush_history() {
        let base =
            std::env::temp_dir().join(format!("viby-playback-contention-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let database = Database::open(base.join("library.sqlite")).unwrap();
        let track = sample_track();
        database.upsert_track(&track).unwrap();
        database
            .save_track_eq_override(&TrackEqOverride {
                track_id: track.id.clone(),
                enabled: true,
                preamp_db: -1.0,
                gains: vec![0.0; 10],
                updated_at: "2024-01-01T00:00:00Z".to_string(),
            })
            .unwrap();

        let history = Arc::new(PlayHistoryWriter::new(database.clone()).unwrap());
        let (player, audio_commands) = AudioPlayer::new_for_test();
        let player = Arc::new(player);

        let (writer_locked_tx, writer_locked_rx) = mpsc::channel();
        let (release_writer_tx, release_writer_rx) = mpsc::channel();
        let writer_database = database.clone();
        let scan_writer = std::thread::spawn(move || {
            writer_database.with_writer_lock_for_test(|| {
                writer_locked_tx.send(()).unwrap();
                release_writer_rx
                    .recv_timeout(Duration::from_secs(5))
                    .expect("test should release the scan writer");
            });
        });
        writer_locked_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("scan writer did not acquire the lock");

        let (playback_done_tx, playback_done_rx) = mpsc::channel();
        let playback_database = database.clone();
        let playback_history = Arc::clone(&history);
        let playback_player = Arc::clone(&player);
        let playback_track = track.clone();
        let playback = std::thread::spawn(move || {
            let result = prepare_playback_track(&playback_database, &playback_track.id)
                .and_then(|prepared| {
                    assert_eq!(prepared.track.file_path, playback_track.file_path);
                    let eq_override = playback_database
                        .get_track_eq_override(&playback_track.id)
                        .map_err(crate::error::AppError::from)?;
                    playback_player
                        .load_track_with_eq_override(
                            &prepared.track.file_path,
                            prepared.track.clone(),
                            eq_override,
                        )
                        .map_err(crate::error::AppError::Other)?;
                    playback_player.seek(37.0);
                    playback_history
                        .try_record_play(&playback_track.id, "play_track")
                        .map_err(|error| crate::error::AppError::Other(error.to_string()))?;
                    Ok::<_, crate::error::AppError>(playback_track.id)
                })
                .map_err(|error| error.to_string());
            let _ = playback_done_tx.send(result);
        });

        let started_before_writer_release = playback_done_rx
            .recv_timeout(Duration::from_millis(500))
            .ok()
            .and_then(Result::ok)
            .is_some_and(|id| id == track.id);
        let commands: Vec<_> = audio_commands.try_iter().collect();
        let load_was_sent = commands.iter().any(|command| {
            matches!(command, AudioCommand::LoadTrack(request)
                if request.path == track.file_path && request.track.id == track.id)
        });
        let seek_was_sent = commands
            .iter()
            .any(|command| matches!(command, AudioCommand::Seek(position) if *position == 37.0));

        release_writer_tx.send(()).unwrap();
        scan_writer.join().unwrap();
        playback.join().unwrap();
        history.flush_for_test();
        let recorded = database
            .get_recently_played(10)
            .unwrap()
            .into_iter()
            .map(|track| track.id)
            .collect::<Vec<_>>();
        let history = Arc::try_unwrap(history).ok().unwrap();
        history.shutdown();
        drop(player);
        drop(database);
        std::fs::remove_dir_all(base).unwrap();

        assert!(
            started_before_writer_release,
            "playback preparation waited for the scan DB writer"
        );
        assert!(
            load_was_sent,
            "audio start command was not sent before release"
        );
        assert!(seek_was_sent, "seek command was not sent before release");
        assert_eq!(recorded, ["queued"]);
    }
}

#[cfg(test)]
mod playback_mode_tests {
    use super::next_repeat_mode;
    use crate::models::RepeatMode;

    #[test]
    fn repeat_cycle_matches_player_control_order() {
        assert_eq!(next_repeat_mode(RepeatMode::Off), RepeatMode::All);
        assert_eq!(next_repeat_mode(RepeatMode::All), RepeatMode::One);
        assert_eq!(next_repeat_mode(RepeatMode::One), RepeatMode::Off);
    }
}

#[cfg(test)]
mod playback_preference_startup_tests {
    use super::initialize_runtime_preferences;
    use crate::audio::preferences::{PlaybackPreferences, PlaybackPreferencesStore};
    use std::fs;
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::Duration;

    fn preferences_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "viby-playback-startup-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn failed_restore_keeps_controls_gated_and_retry_applies_saved_preferences() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        let legacy = PlaybackPreferences {
            volume: 0.4,
            is_muted: true,
            previous_volume: 0.4,
            shuffle: true,
            repeat_mode: "all".to_string(),
        };
        let (apply_started_tx, apply_started_rx) = mpsc::channel();
        let (apply_result_tx, apply_result_rx) = mpsc::channel();
        let runtime = Arc::new(Mutex::new(PlaybackPreferences::default()));
        let startup_store = store.clone();
        let startup_runtime = Arc::clone(&runtime);
        let startup = thread::spawn(move || {
            initialize_runtime_preferences(&startup_store, Some(legacy), |restored| {
                {
                    let mut runtime = startup_runtime.lock().unwrap();
                    runtime.volume = restored.volume;
                    runtime.is_muted = restored.is_muted;
                    runtime.previous_volume = restored.previous_volume;
                }
                apply_started_tx.send(restored.clone()).unwrap();
                apply_result_rx.recv().unwrap()
            })
        });

        let persisted = apply_started_rx
            .recv()
            .expect("startup should pass the saved snapshot to runtime restore");
        assert_eq!(runtime.lock().unwrap().volume, persisted.volume);
        assert_eq!(
            runtime.lock().unwrap().previous_volume,
            persisted.previous_volume
        );
        assert!(!runtime.lock().unwrap().shuffle);
        assert_eq!(runtime.lock().unwrap().repeat_mode, "off");
        assert!(store.ensure_initialized().is_err());

        let control_store = store.clone();
        let (control_started_tx, control_started_rx) = mpsc::channel();
        let (control_result_tx, control_result_rx) = mpsc::channel();
        let control = thread::spawn(move || {
            control_started_tx.send(()).unwrap();
            let _controls = control_store
                .lock_controls()
                .expect("control gate should unlock after failed restore");
            control_result_tx
                .send(control_store.ensure_initialized())
                .unwrap();
        });
        control_started_rx
            .recv()
            .expect("control request should attempt startup gate");

        apply_result_tx
            .send(Err("injected queue mode application failure".to_string()))
            .unwrap();
        assert_eq!(
            startup.join().expect("startup thread should finish"),
            Err("injected queue mode application failure".to_string())
        );
        assert!(
            control_result_rx
                .recv()
                .expect("waiting control should pass through the gate")
                .is_err()
        );
        control.join().expect("control thread should finish");

        let mut retried_snapshot = None;
        let retry_runtime = Arc::clone(&runtime);
        initialize_runtime_preferences(&store, Some(PlaybackPreferences::default()), |restored| {
            retried_snapshot = Some(restored.clone());
            *retry_runtime.lock().unwrap() = restored.clone();
            Ok(())
        })
        .expect("startup retry should apply persisted preferences");
        assert_eq!(retried_snapshot.as_ref(), Some(&persisted));
        assert_eq!(*runtime.lock().unwrap(), persisted);
        store
            .ensure_initialized()
            .expect("controls should open after runtime restore acknowledgement");
        initialize_runtime_preferences(&store, None, |_| {
            panic!("a ready runtime must not replay startup restoration")
        })
        .expect("repeated startup should keep the applied state");

        drop(store);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_startup_and_control_apply_keep_the_newer_runtime_state() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        let runtime = Arc::new(Mutex::new(None::<PlaybackPreferences>));
        let second_initializer_applies = Arc::new(Mutex::new(Vec::new()));
        let first_preferences = PlaybackPreferences {
            volume: 0.0,
            is_muted: true,
            previous_volume: 0.25,
            shuffle: true,
            repeat_mode: "all".to_string(),
        };
        let (restore_started_tx, restore_started_rx) = mpsc::channel();
        let (finish_restore_tx, finish_restore_rx) = mpsc::channel();

        let first_store = store.clone();
        let first_runtime = Arc::clone(&runtime);
        let first = thread::spawn(move || {
            initialize_runtime_preferences(&first_store, Some(first_preferences), |restored| {
                restore_started_tx.send(restored.clone()).unwrap();
                finish_restore_rx.recv().unwrap();
                *first_runtime.lock().unwrap() = Some(restored.clone());
                Ok(())
            })
        });

        let restoring = restore_started_rx
            .recv_timeout(Duration::from_secs(2))
            .expect("first initializer should reach runtime restore");
        assert!(restoring.is_muted);
        assert_eq!(restoring.previous_volume, 0.25);

        let second_store = store.clone();
        let second_runtime = Arc::clone(&runtime);
        let second_applies = Arc::clone(&second_initializer_applies);
        let (second_started_tx, second_started_rx) = mpsc::channel();
        let second = thread::spawn(move || {
            second_started_tx.send(()).unwrap();
            initialize_runtime_preferences(
                &second_store,
                Some(PlaybackPreferences::default()),
                |restored| {
                    second_applies.lock().unwrap().push(restored.clone());
                    *second_runtime.lock().unwrap() = Some(restored.clone());
                    Ok(())
                },
            )
        });

        let control_store = store.clone();
        let control_runtime = Arc::clone(&runtime);
        let (control_started_tx, control_started_rx) = mpsc::channel();
        let (control_result_tx, control_result_rx) = mpsc::channel();
        let control = thread::spawn(move || {
            control_started_tx.send(()).unwrap();
            let result = (|| {
                let _controls = control_store.lock_controls()?;
                control_store.ensure_initialized()?;
                control_store.update_volume(0.7, false, 0.7);
                control_store.set_shuffle(false);
                control_store.set_repeat_mode("one");
                let current = control_store.snapshot();
                *control_runtime.lock().unwrap() = Some(current);
                Ok::<_, String>(())
            })();
            control_result_tx.send(result.clone()).unwrap();
            result
        });

        second_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("second initializer should start");
        control_started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("control update should start");
        let second_applied_while_restoring = second_initializer_applies
            .lock()
            .map(|applied| !applied.is_empty())
            .unwrap_or(true);
        let control_finished_while_restoring = control_result_rx
            .recv_timeout(Duration::from_millis(50))
            .is_ok();

        finish_restore_tx
            .send(())
            .expect("first runtime restore should resume");
        first
            .join()
            .expect("first initializer should finish")
            .expect("first runtime restore should succeed");
        second
            .join()
            .expect("second initializer should finish")
            .expect("second initializer should observe the ready runtime");
        control
            .join()
            .expect("control update should finish")
            .expect("control should run after startup restoration");

        let persisted = store.snapshot();
        let applied_runtime = runtime.lock().unwrap().clone().unwrap();
        assert!(
            !second_applied_while_restoring,
            "a second initializer must not restore while the first restore is in progress"
        );
        assert!(
            !control_finished_while_restoring,
            "control admission must remain serialized until runtime restore completes"
        );
        assert!(second_initializer_applies.lock().unwrap().is_empty());
        assert_eq!(applied_runtime, persisted);
        assert_eq!(applied_runtime.volume, 0.7);
        assert!(!applied_runtime.is_muted);
        assert_eq!(applied_runtime.previous_volume, 0.7);
        assert!(!applied_runtime.shuffle);
        assert_eq!(applied_runtime.repeat_mode, "one");
        store.flush().expect("newer control state should persist");

        drop(store);
        let _ = fs::remove_file(path);
    }
}
