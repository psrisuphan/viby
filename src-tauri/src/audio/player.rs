// =============================================================================
// audio/player.rs — Core audio playback engine
// =============================================================================
//
// This is the heart of Viby's audio system. Because rodio's `Sink` type
// cannot be safely shared between threads (it's not Send/Sync), we run all
// audio operations on a DEDICATED THREAD and communicate with it via channels.
//
// Architecture (think of it like a message queue):
//
//   ┌─────────────┐   mpsc channel    ┌─────────────────┐
//   │ Tauri cmds   │ ──── send ────▶  │ Audio Thread     │
//   │ (any thread) │                  │ (owns the Sink)  │
//   └─────────────┘                   └─────────────────┘
//                                            │
//                                      emits events
//                                            │
//                                            ▼
//                                     ┌────────────┐
//                                     │  Frontend   │
//                                     └────────────┘
//
// Key Rust concepts:
//   - `mpsc::channel` → like a message queue (multiple senders, one receiver)
//   - `std::thread::spawn` → creates a new OS thread
//   - `Arc<Mutex<T>>` → thread-safe shared pointer with a lock
//   - `Box<dyn Error>` → like `any` for errors — can hold any error type
// =============================================================================

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::audio::eq::{BAND_COUNT, BandConfig, EqParams, PEQ_BAND_COUNT};
use crate::audio::normalization::NormalizationParams;
use crate::audio::output::OutputSummary;
use crate::audio::queue::{PlaybackQueue, QueueState};
use crate::audio::runtime::run_audio_thread;
use crate::library::database::Database;
use crate::models::{AudioPathStatus, PlaybackState, QueuePositionPayload, Track};
pub(crate) fn emit_queue_position_changed(app: &AppHandle, q: &PlaybackQueue) {
    let payload = QueuePositionPayload {
        current_index: q.get_current_index(),
    };
    if playback_debug_enabled() {
        eprintln!(
            "[AudioPlayer] queue-position-changed current_index={:?} queue_len={}",
            payload.current_index,
            q.len()
        );
    }
    safe_emit(app, "queue-position-changed", &payload);
}

pub(crate) fn playback_debug_enabled() -> bool {
    std::env::var("VIBY_PLAYBACK_DEBUG")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
        .unwrap_or(false)
}

pub(crate) fn media_progress_due(last: Option<Instant>, now: Instant, state_changed: bool) -> bool {
    state_changed || last.is_none_or(|last| now.duration_since(last) >= Duration::from_secs(1))
}

const PAUSED_AUDIO_RELEASE_DELAY: Duration = Duration::from_secs(30);

pub(crate) fn audio_command_timeout(
    is_playing: bool,
    paused_since: Option<Instant>,
    now: Instant,
) -> Option<Duration> {
    if is_playing {
        Some(Duration::from_millis(50))
    } else {
        paused_since
            .map(|paused| PAUSED_AUDIO_RELEASE_DELAY.saturating_sub(now.duration_since(paused)))
    }
}

pub(crate) fn audio_output_should_release(has_current_track: bool, track_ended: bool) -> bool {
    !has_current_track || track_ended
}

pub(crate) fn debug_log_event(event_type: &str, message: &str) {
    if playback_debug_enabled() {
        crate::utils::log_rust_event(event_type, message);
    }
}

pub(crate) fn record_play(app: &AppHandle, track_id: &str) {
    if let Some(db) = app.try_state::<Mutex<Database>>() {
        match db.lock() {
            Ok(db) => {
                if let Err(error) = db.record_play(track_id) {
                    eprintln!("[AudioPlayer] Failed to record play for {track_id}: {error}");
                }
            }
            Err(error) => {
                eprintln!("[AudioPlayer] Failed to lock history database for {track_id}: {error}");
            }
        }
    }
}

pub(crate) fn next_preload_candidate(app: &AppHandle) -> Option<Track> {
    let queue = app.try_state::<QueueState>()?;
    let q = queue.0.lock().ok()?;
    q.peek_next(false).cloned()
}
// =============================================================================
// AudioCommand — messages we send to the audio thread
// =============================================================================

/// Commands that can be sent to the audio thread.
pub(crate) enum AudioCommand {
    LoadTrack(String, Box<Track>),
    Pause,
    Resume,
    Stop,
    Seek(f64),
    SetVolume(f32),
    /// Gracefully shut down the audio thread.
    Shutdown(Sender<()>),
}

// =============================================================================
// AudioPlayerState — shared state between main thread and audio thread
// =============================================================================

/// Internal state shared between the audio thread and command handlers.
/// Protected by a Mutex so multiple threads can read/write safely.
/// (A Mutex is like a lock — only one thread can access the data at a time.)
#[derive(Debug)]
pub(crate) struct AudioPlayerInner {
    /// Whether we're currently playing
    pub(crate) is_playing: bool,
    /// The currently loaded track (if any)
    pub(crate) current_track: Option<Track>,
    /// The file path of the currently loaded track (needed for seek fallback)
    pub(crate) current_path: Option<String>,
    /// The next track already appended to the sink for gapless playback.
    pub(crate) queued_track: Option<Track>,
    /// The path for the preloaded next track.
    pub(crate) queued_path: Option<String>,
    /// Current position in seconds (updated by the progress timer)
    pub(crate) position_secs: f64,
    /// Total duration of the current track
    pub(crate) duration_secs: f64,
    /// Current volume level (0.0 to 1.0)
    pub(crate) volume: f32,
    /// Sample rate of the currently loaded source, used for EQ/preamp calculations.
    pub(crate) sample_rate: u32,
    /// Number of audio channels in the currently loaded source.
    pub(crate) channels: u32,
    /// Bit depth (bits per sample) of the currently loaded source.
    pub(crate) bits_per_sample: Option<u32>,
    /// Native sample rate of the preloaded next track.
    pub(crate) queued_sample_rate: Option<u32>,
    /// Number of audio channels in the preloaded next track.
    pub(crate) queued_channels: Option<u32>,
    /// Bit depth of the preloaded next track.
    pub(crate) queued_bits_per_sample: Option<u32>,
    /// Actual sample rate selected for the output device.
    pub(crate) output_sample_rate: Option<u32>,
    /// Actual channel count selected for the output device.
    pub(crate) output_channels: Option<u32>,
    /// Actual sample format selected for the output device.
    pub(crate) output_sample_format: Option<String>,
    /// Why the output path fell back instead of matching the current source.
    pub(crate) output_fallback_reason: Option<String>,
    /// Added to sink.get_pos() to get the true file position.
    /// Non-zero after a fallback seek: the skipped source's get_pos() starts at 0,
    /// so we add the seek target to recover the real position.
    pub(crate) seek_position_offset: f64,
    /// The cumulative position of the sink when the current track started.
    /// Used to calculate per-track position: sink.get_pos() - sink_baseline_secs.
    pub(crate) sink_baseline_secs: f64,
    /// After a fast seek (try_seek), get_pos() may briefly return 0 before rodio
    /// updates its internal counter. We ignore get_pos() until this instant passes.
    pub(crate) seek_guard_until: Option<Instant>,
}

pub(crate) fn update_output_state(state: &mut AudioPlayerInner, output: &OutputSummary) {
    state.output_sample_rate = Some(output.sample_rate);
    state.output_channels = Some(output.channels);
    state.output_sample_format = Some(output.sample_format.clone());
    state.output_fallback_reason = output.fallback_reason.clone();
}

fn audio_path_status(state: &AudioPlayerInner, eq_params: &EqParams) -> AudioPathStatus {
    let snap = eq_params.snapshot();
    let has_track = state.current_track.is_some();
    let source_sample_rate = has_track.then_some(state.sample_rate);
    let source_channels = has_track.then_some(state.channels);
    let source_bits_per_sample = has_track.then_some(state.bits_per_sample).flatten();
    let rate_mismatch = has_track
        && state
            .output_sample_rate
            .is_some_and(|output_rate| output_rate != state.sample_rate);
    let channel_mismatch = has_track
        && state
            .output_channels
            .is_some_and(|output_channels| output_channels != state.channels);
    let resampling_active = rate_mismatch || channel_mismatch;
    let fallback_reason = state.output_fallback_reason.clone();
    let status = if !has_track {
        "idle"
    } else if fallback_reason.is_some() || state.output_sample_rate.is_none() {
        "fallback_device"
    } else if resampling_active {
        "resampled_dsp"
    } else if snap.enabled {
        "native_dsp"
    } else {
        "native"
    };

    AudioPathStatus {
        source_sample_rate,
        source_channels,
        source_bits_per_sample,
        output_sample_rate: state.output_sample_rate,
        output_channels: state.output_channels,
        output_sample_format: state.output_sample_format.clone(),
        dsp_enabled: snap.enabled,
        eq_mode: if snap.peq_mode {
            "parametric".to_string()
        } else {
            "graphic".to_string()
        },
        app_gain: state.volume,
        resampling_active,
        status: status.to_string(),
        fallback_reason,
    }
}

pub(crate) fn playback_state_from_inner(
    state: &AudioPlayerInner,
    eq_params: &EqParams,
) -> PlaybackState {
    PlaybackState {
        is_playing: state.is_playing,
        current_track: state.current_track.clone(),
        position_secs: state.position_secs,
        duration_secs: state.duration_secs,
        volume: state.volume,
        shuffle: false,
        repeat_mode: "off".to_string(),
        sample_rate: state.current_track.as_ref().map(|_| state.sample_rate),
        channels: state.current_track.as_ref().map(|_| state.channels),
        bits_per_sample: state.current_track.as_ref().and(state.bits_per_sample),
        audio_path: audio_path_status(state, eq_params),
    }
}

fn default_playback_state() -> PlaybackState {
    PlaybackState {
        is_playing: false,
        current_track: None,
        position_secs: 0.0,
        duration_secs: 0.0,
        volume: 1.0,
        shuffle: false,
        repeat_mode: "off".to_string(),
        sample_rate: None,
        channels: None,
        bits_per_sample: None,
        audio_path: AudioPathStatus::idle(),
    }
}

// =============================================================================
// AudioPlayer — the public API for controlling audio
// =============================================================================

thread_local! {
    pub(crate) static HOLDING_PLAYER_LOCK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

pub struct TrackedMutex<T> {
    inner: Mutex<T>,
}

impl<T> TrackedMutex<T> {
    pub fn new(val: T) -> Self {
        Self {
            inner: Mutex::new(val),
        }
    }

    pub fn lock(
        &self,
    ) -> Result<TrackedMutexGuard<'_, T>, std::sync::PoisonError<std::sync::MutexGuard<'_, T>>>
    {
        let guard = self.inner.lock()?;
        HOLDING_PLAYER_LOCK.with(|flag| flag.set(true));
        Ok(TrackedMutexGuard { guard })
    }
}

pub struct TrackedMutexGuard<'a, T> {
    guard: std::sync::MutexGuard<'a, T>,
}

impl<'a, T> Drop for TrackedMutexGuard<'a, T> {
    fn drop(&mut self) {
        HOLDING_PLAYER_LOCK.with(|flag| flag.set(false));
    }
}

impl<'a, T> std::ops::Deref for TrackedMutexGuard<'a, T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.guard
    }
}

impl<'a, T> std::ops::DerefMut for TrackedMutexGuard<'a, T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.guard
    }
}

pub(crate) fn safe_emit<S: serde::Serialize>(app: &AppHandle, event: &str, payload: &S) {
    HOLDING_PLAYER_LOCK.with(|flag| {
        assert!(
            !flag.get(),
            "DEADLOCK RISK: Attempted to emit event '{}' while holding AudioPlayerInner lock on the current thread!",
            event
        );
    });
    if let Err(error) = app.emit(event, payload) {
        eprintln!("[AudioPlayer] Failed to emit {event}: {error}");
    }
}

pub(crate) type PlaybackSignature = (bool, Option<String>, f64, f32);

pub(crate) fn playback_signature(state: &AudioPlayerInner) -> PlaybackSignature {
    (
        state.is_playing,
        state.current_track.as_ref().map(|track| track.id.clone()),
        state.duration_secs,
        state.volume,
    )
}

pub(crate) fn publish_command_state(
    app: &AppHandle,
    playback_state: &PlaybackState,
    last_emit: Instant,
) -> Instant {
    let elapsed = last_emit.elapsed();
    if elapsed < Duration::from_millis(50) {
        std::thread::sleep(Duration::from_millis(50) - elapsed);
    }

    safe_emit(app, "playback-state", playback_state);
    if let Some(controls_state) = app.try_state::<Mutex<souvlaki::MediaControls>>()
        && let Ok(mut controls) = controls_state.lock()
    {
        let progress = Some(souvlaki::MediaPosition(Duration::from_secs_f64(
            playback_state.position_secs.max(0.0),
        )));
        let playback = if playback_state.is_playing {
            souvlaki::MediaPlayback::Playing { progress }
        } else if playback_state.current_track.is_some() {
            souvlaki::MediaPlayback::Paused { progress }
        } else {
            souvlaki::MediaPlayback::Stopped
        };
        if let Err(error) = controls.set_playback(playback) {
            eprintln!("[AudioPlayer] Failed to update media playback state: {error}");
        }
        if playback_state.current_track.is_none() {
            if let Err(error) = controls.set_metadata(souvlaki::MediaMetadata::default()) {
                eprintln!("[AudioPlayer] Failed to clear media metadata: {error}");
            }
        }
    }
    Instant::now()
}

/// The main audio player. This struct is stored in Tauri's managed state
/// so all commands can access it. It communicates with the audio thread
/// via a channel (like postMessage in a Web Worker).
pub struct AudioPlayer {
    /// Channel sender to send commands to the audio thread.
    /// Wrapped in a Mutex because Tauri commands might call from different threads.
    command_tx: Mutex<Sender<AudioCommand>>,
    /// Shared state that both the audio thread and command handlers can read.
    /// Arc = "Atomically Reference Counted" — like a shared pointer.
    /// Mutex = lock for safe concurrent access.
    inner: Arc<TrackedMutex<AudioPlayerInner>>,
    /// Equalizer parameters, shared lock-free with the audio thread's EqSource.
    /// Writing here is picked up by the playing source without a round-trip.
    eq_params: Arc<EqParams>,
    global_eq_params: Arc<EqParams>,
    track_eq_override_active: AtomicBool,
    /// Sound Check enabled flag, shared lock-free with each NormalizationSource.
    normalization_params: Arc<NormalizationParams>,
}

impl AudioPlayer {
    /// Create a new AudioPlayer and start the background audio thread.
    ///
    /// # Arguments
    /// * `app_handle` — Tauri's app handle, used to emit events to the frontend
    ///
    /// # How it works
    /// 1. Creates a channel for sending commands
    /// 2. Creates shared state (Arc<Mutex<>>)
    /// 3. Spawns a dedicated thread that:
    ///    - Owns the rodio OutputStream and Sink
    ///    - Listens for commands on the channel
    ///    - Emits progress events to the frontend
    pub fn new(app_handle: AppHandle) -> Self {
        // Create the command channel (like creating a message queue)
        let (tx, rx) = mpsc::channel::<AudioCommand>();

        // Create shared state with initial values
        let inner = Arc::new(TrackedMutex::new(AudioPlayerInner {
            is_playing: false,
            current_track: None,
            current_path: None,
            queued_track: None,
            queued_path: None,
            position_secs: 0.0,
            duration_secs: 0.0,
            volume: 1.0,
            sample_rate: 48_000,
            channels: 2,
            bits_per_sample: None,
            queued_sample_rate: None,
            queued_channels: None,
            queued_bits_per_sample: None,
            output_sample_rate: None,
            output_channels: None,
            output_sample_format: None,
            output_fallback_reason: None,
            seek_position_offset: 0.0,
            sink_baseline_secs: 0.0,
            seek_guard_until: None,
        }));

        // Clone the Arc so the audio thread gets its own reference
        // (Arc cloning is cheap — it just increments a counter)
        let inner_clone = Arc::clone(&inner);

        // Shared equalizer parameters (flat + disabled by default).
        let eq_params = Arc::new(EqParams::new());
        let eq_params_thread = Arc::clone(&eq_params);
        let global_eq_params = Arc::new(EqParams::new());
        let normalization_params = Arc::new(NormalizationParams::new(false));
        let normalization_params_thread = Arc::clone(&normalization_params);

        // Spawn the dedicated audio thread
        std::thread::spawn(move || {
            run_audio_thread(
                app_handle,
                rx,
                inner_clone,
                eq_params_thread,
                normalization_params_thread,
            );
        });

        AudioPlayer {
            command_tx: Mutex::new(tx),
            inner,
            eq_params,
            global_eq_params,
            track_eq_override_active: AtomicBool::new(false),
            normalization_params,
        }
    }

    // =========================================================================
    // Public API — these methods are called from Tauri command handlers
    // =========================================================================

    /// Load and play a track.
    ///
    /// # Arguments
    /// * `path` — absolute path to the audio file
    /// * `track` — the Track metadata (so we can track what's playing)
    pub fn load_track(&self, path: &str, track: Track) {
        debug_log_event(
            "player_api",
            &format!("load_track: path={}, title={}", path, track.title),
        );
        if let Ok(mut state) = self.inner.lock() {
            state.current_track = Some(track.clone());
            state.duration_secs = track.duration_secs;
            state.position_secs = 0.0;
            state.queued_track = None;
            state.queued_path = None;
        }
        self.send(AudioCommand::LoadTrack(path.to_string(), Box::new(track)));
        debug_log_event("player_api", "load_track: AudioCommand::LoadTrack sent");
    }

    pub fn pause(&self) {
        self.send(AudioCommand::Pause);
    }

    pub fn resume(&self) {
        self.send(AudioCommand::Resume);
    }

    pub fn stop(&self) {
        self.send(AudioCommand::Stop);
    }

    pub fn seek(&self, position_secs: f64) {
        self.send(AudioCommand::Seek(position_secs));
    }

    pub fn set_volume(&self, volume: f32) {
        self.send(AudioCommand::SetVolume(volume.clamp(0.0, 1.0)));
    }

    pub fn set_sound_check_enabled(&self, enabled: bool) {
        self.normalization_params.set_enabled(enabled);
    }

    pub fn set_sound_check_target_lufs(&self, target_lufs: f32) {
        self.normalization_params.set_target_lufs(target_lufs);
    }

    /// Update equalizer parameters. Writes the shared `EqParams` block directly;
    /// the audio thread's `EqSource` picks up the change on its next recheck
    /// (no command round-trip needed). Also works while nothing is playing —
    /// the next loaded track will use the new settings.
    pub fn set_eq(&self, enabled: bool, preamp_db: f32, gains_db: [f32; BAND_COUNT]) {
        self.global_eq_params.set(enabled, preamp_db, gains_db);
        if !self.track_eq_override_active.load(Ordering::SeqCst) {
            self.eq_params.set(enabled, preamp_db, gains_db);
        }
    }

    pub fn set_peq(
        &self,
        enabled: bool,
        preamp_db: f32,
        bands: [(bool, u8, f32, f32, f32); PEQ_BAND_COUNT],
    ) {
        self.global_eq_params.set_peq(enabled, preamp_db, bands);
        if !self.track_eq_override_active.load(Ordering::SeqCst) {
            self.eq_params.set_peq(enabled, preamp_db, bands);
        }
    }

    pub fn apply_track_eq_override(
        &self,
        enabled: bool,
        preamp_db: f32,
        gains_db: [f32; BAND_COUNT],
    ) {
        self.track_eq_override_active.store(true, Ordering::SeqCst);
        self.eq_params.set(enabled, preamp_db, gains_db);
    }

    pub fn clear_track_eq_override(&self) {
        self.track_eq_override_active.store(false, Ordering::SeqCst);
        self.eq_params
            .apply_snapshot(&self.global_eq_params.snapshot());
    }

    /// Set oversampling ratio (1, 2, or 4). Default is 2.
    pub fn set_eq_oversampling(&self, ratio: u8) {
        self.eq_params.set_oversampling(ratio);
    }

    /// Set EQ topology (0 = TDF2, 1 = SVF). Default is 0.
    pub fn set_eq_topology(&self, mode: u8) {
        self.eq_params.set_topology(mode);
    }

    /// Get a reference to the shared EqParams (for reading state).
    pub fn eq_params(&self) -> &Arc<EqParams> {
        &self.eq_params
    }

    /// Compute recommended preamp gain from current PEQ bands.
    pub fn recommended_preamp_db(&self) -> f32 {
        let snap = self.eq_params.snapshot();
        if snap.peq_mode {
            let bands: Vec<BandConfig> = snap
                .peq_bands
                .iter()
                .map(|b| BandConfig {
                    enabled: b.enabled,
                    filter_type: if b.enabled { b.filter_type } else { 0 },
                    freq: b.freq as f64,
                    gain_db: b.gain as f64,
                    q: b.q.max(0.01) as f64,
                })
                .collect();
            let sample_rate = self
                .inner
                .lock()
                .map(|state| state.sample_rate as f64)
                .unwrap_or(48_000.0);
            crate::audio::eq::recommended_preamp_gain(&bands, sample_rate) as f32
        } else {
            // For GEQ, just use the most negative gain as a heuristic
            let max_boost = snap.gains_db.iter().cloned().fold(0f32, |a, b| a.max(b));
            if max_boost > 0.0 { -max_boost } else { 0.0 }
        }
    }

    /// Get a snapshot of the current playback state.
    /// This reads from the shared state (no need to ask the audio thread).
    pub fn get_state(&self) -> PlaybackState {
        if let Ok(state) = self.inner.lock() {
            playback_state_from_inner(&state, &self.eq_params)
        } else {
            default_playback_state()
        }
    }

    /// Check if a track is currently loaded and playing.
    pub fn is_playing(&self) -> bool {
        self.inner.lock().map(|s| s.is_playing).unwrap_or(false)
    }

    pub fn shutdown(&self) {
        let (done_tx, done_rx) = mpsc::channel();
        let sent = self
            .command_tx
            .lock()
            .ok()
            .is_some_and(|tx| tx.send(AudioCommand::Shutdown(done_tx)).is_ok());
        if sent {
            let _ = done_rx.recv_timeout(Duration::from_millis(250));
        }
    }

    fn send(&self, cmd: AudioCommand) {
        if let Ok(tx) = self.command_tx.lock()
            && tx.send(cmd).is_err()
        {
            eprintln!("[AudioPlayer] Audio thread is no longer running — command dropped.");
        }
    }
}

/// Send a Shutdown command to the audio thread when AudioPlayer is dropped
/// so the thread exits cleanly and the OS audio device is released promptly.
impl Drop for AudioPlayer {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use crate::audio::media::prune_artwork_files;
    use crate::audio::session::normalized_seek_position;

    use super::{
        PAUSED_AUDIO_RELEASE_DELAY, audio_command_timeout, audio_output_should_release,
        media_progress_due,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn media_progress_is_immediate_for_state_changes_and_throttled_otherwise() {
        let now = Instant::now();
        assert!(media_progress_due(Some(now), now, true));
        assert!(!media_progress_due(
            Some(now),
            now + Duration::from_millis(999),
            false
        ));
        assert!(media_progress_due(
            Some(now),
            now + Duration::from_secs(1),
            false
        ));
    }

    #[test]
    fn audio_thread_polls_while_playing_and_times_out_a_long_pause() {
        let now = Instant::now();
        assert_eq!(audio_command_timeout(false, None, now), None);
        assert_eq!(
            audio_command_timeout(true, None, now),
            Some(Duration::from_millis(50))
        );
        assert_eq!(
            audio_command_timeout(false, Some(now), now),
            Some(PAUSED_AUDIO_RELEASE_DELAY)
        );
        assert_eq!(
            audio_command_timeout(false, Some(now - PAUSED_AUDIO_RELEASE_DELAY), now),
            Some(Duration::ZERO)
        );
    }

    #[test]
    fn media_artwork_disk_cache_is_bounded() {
        let dir = std::env::temp_dir().join(format!("viby-artwork-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for index in 0..4 {
            std::fs::write(dir.join(format!("{index}.jpg")), [index]).unwrap();
        }

        prune_artwork_files(&dir, 2, u64::MAX);

        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        prune_artwork_files(&dir, usize::MAX, 1);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn audio_output_is_kept_for_pause_but_released_for_stop_or_track_end() {
        assert!(!audio_output_should_release(true, false));
        assert!(audio_output_should_release(false, false));
        assert!(audio_output_should_release(true, true));
    }

    #[test]
    fn seek_position_is_finite_and_bounded_by_duration() {
        assert_eq!(normalized_seek_position(-1.0, 120.0), Some(0.0));
        assert_eq!(normalized_seek_position(42.0, 120.0), Some(42.0));
        assert_eq!(normalized_seek_position(180.0, 120.0), Some(120.0));
        assert_eq!(normalized_seek_position(f64::NAN, 120.0), None);
    }
}
