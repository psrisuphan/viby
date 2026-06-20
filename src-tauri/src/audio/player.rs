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

use std::fs::File;
use std::hash::{Hash, Hasher};
use std::sync::mpsc::{self, Sender, TryRecvError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rodio::{Sink, Source};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::eq::{BAND_COUNT, BandConfig, EqParams, EqSource, PEQ_BAND_COUNT};
use crate::audio::output::{AudioOutput, OutputSummary};
use crate::audio::queue::{PlaybackQueue, QueueState};
use crate::library::database::Database;
use crate::models::{AudioPathStatus, PlaybackState, QueuePositionPayload, Track};

fn mpris_cover_url(app_handle: &AppHandle, track: &Track) -> Option<String> {
    let metadata = crate::library::metadata::extract_metadata(&track.file_path).ok();
    let artwork_bytes = metadata.and_then(|m| m.artwork).or_else(|| {
        let path = std::path::Path::new(&track.file_path);
        let parent = path.parent()?;
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
            "artwork.jpg",
            "artwork.jpeg",
            "artwork.png",
        ];

        for entry in std::fs::read_dir(parent).ok()?.flatten() {
            if entry.file_type().ok()?.is_file() {
                let file_name = entry.file_name().to_string_lossy().to_lowercase();
                if common_names.contains(&file_name.as_str())
                    && let Ok(bytes) = std::fs::read(entry.path())
                {
                    return Some(bytes);
                }
            }
        }
        None
    })?;

    let extension = if artwork_bytes.starts_with(b"\x89PNG") {
        "png"
    } else if artwork_bytes.starts_with(b"GIF") {
        "gif"
    } else if artwork_bytes.starts_with(b"RIFF")
        && artwork_bytes.len() > 12
        && &artwork_bytes[8..12] == b"WEBP"
    {
        "webp"
    } else {
        "jpg"
    };

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    track.album.hash(&mut hasher);
    track.album_artist.hash(&mut hasher);
    track.id.hash(&mut hasher);
    let file_name = format!("{:x}.{extension}", hasher.finish());

    let dir = app_handle.path().app_data_dir().ok()?.join("mpris-artwork");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(file_name);
    if !path.exists() {
        std::fs::write(&path, artwork_bytes).ok()?;
    }

    Some(path_to_file_uri(&path))
}

fn path_to_file_uri(path: &std::path::Path) -> String {
    fn encode_segment(input: &str) -> String {
        let mut out = String::new();
        for byte in input.bytes() {
            let keep = byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
            if keep {
                out.push(byte as char);
            } else {
                out.push_str(&format!("%{byte:02X}"));
            }
        }
        out
    }

    let encoded = path
        .components()
        .filter_map(|component| match component {
            std::path::Component::RootDir => None,
            std::path::Component::Normal(part) => Some(encode_segment(&part.to_string_lossy())),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    format!("file:///{encoded}")
}

fn emit_queue_position_changed(app: &AppHandle, q: &PlaybackQueue) {
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

fn playback_debug_enabled() -> bool {
    std::env::var("VIBY_PLAYBACK_DEBUG")
        .map(|value| matches!(value.as_str(), "1" | "true" | "TRUE" | "yes" | "on"))
        .unwrap_or(false)
}

fn debug_log_event(event_type: &str, message: &str) {
    if playback_debug_enabled() {
        crate::utils::log_rust_event(event_type, message);
    }
}

fn record_play(app: &AppHandle, track_id: &str) {
    if let Some(db) = app.try_state::<Mutex<Database>>()
        && let Ok(db) = db.lock()
    {
        let _ = db.record_play(track_id);
    }
}

fn next_preload_candidate(app: &AppHandle) -> Option<Track> {
    let queue = app.try_state::<QueueState>()?;
    let q = queue.0.lock().ok()?;
    q.peek_next(false).cloned()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct DecodedTrackSpec {
    sample_rate: u32,
    channels: u32,
    bits_per_sample: Option<u32>,
}

enum PreloadOutcome {
    Appended(DecodedTrackSpec),
    Skipped {
        spec: DecodedTrackSpec,
        reason: String,
    },
}

fn append_decoded_track(
    sink: &Sink,
    path: &str,
    eq_params: &Arc<EqParams>,
    output: &OutputSummary,
) -> Result<PreloadOutcome, String> {
    let file =
        File::open(path).map_err(|e| format!("[AudioPlayer] Failed to open file '{path}': {e}"))?;
    let extension = std::path::Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str());
    let source = crate::audio::decoder::SymphoniaDecoder::new(file, extension)
        .map_err(|e| format!("[AudioPlayer] Failed to decode '{path}': {e}"))?;
    let spec = DecodedTrackSpec {
        sample_rate: source.sample_rate(),
        channels: source.channels() as u32,
        bits_per_sample: source.bits_per_sample(),
    };

    if output.sample_rate != spec.sample_rate || output.channels != spec.channels {
        return Ok(PreloadOutcome::Skipped {
            spec,
            reason: format!(
                "preload skipped to avoid resampling/remixing: source={} Hz/{} ch, output={} Hz/{} ch",
                spec.sample_rate, spec.channels, output.sample_rate, output.channels
            ),
        });
    }

    let eq_source = EqSource::new(source, Arc::clone(eq_params));
    sink.append(eq_source);
    Ok(PreloadOutcome::Appended(spec))
}

// =============================================================================
// AudioCommand — messages we send to the audio thread
// =============================================================================

/// Commands that can be sent to the audio thread.
enum AudioCommand {
    LoadTrack(String, Box<Track>),
    Pause,
    Resume,
    Stop,
    Seek(f64),
    SetVolume(f32),
    /// Gracefully shut down the audio thread.
    Shutdown,
}

// =============================================================================
// AudioPlayerState — shared state between main thread and audio thread
// =============================================================================

/// Internal state shared between the audio thread and command handlers.
/// Protected by a Mutex so multiple threads can read/write safely.
/// (A Mutex is like a lock — only one thread can access the data at a time.)
#[derive(Debug)]
struct AudioPlayerInner {
    /// Whether we're currently playing
    is_playing: bool,
    /// The currently loaded track (if any)
    current_track: Option<Track>,
    /// The file path of the currently loaded track (needed for seek fallback)
    current_path: Option<String>,
    /// The next track already appended to the sink for gapless playback.
    queued_track: Option<Track>,
    /// The path for the preloaded next track.
    queued_path: Option<String>,
    /// Current position in seconds (updated by the progress timer)
    position_secs: f64,
    /// Total duration of the current track
    duration_secs: f64,
    /// Current volume level (0.0 to 1.0)
    volume: f32,
    /// Sample rate of the currently loaded source, used for EQ/preamp calculations.
    sample_rate: u32,
    /// Number of audio channels in the currently loaded source.
    channels: u32,
    /// Bit depth (bits per sample) of the currently loaded source.
    bits_per_sample: Option<u32>,
    /// Native sample rate of the preloaded next track.
    queued_sample_rate: Option<u32>,
    /// Number of audio channels in the preloaded next track.
    queued_channels: Option<u32>,
    /// Bit depth of the preloaded next track.
    queued_bits_per_sample: Option<u32>,
    /// Actual sample rate selected for the output device.
    output_sample_rate: Option<u32>,
    /// Actual channel count selected for the output device.
    output_channels: Option<u32>,
    /// Actual sample format selected for the output device.
    output_sample_format: Option<String>,
    /// Why the output path fell back instead of matching the current source.
    output_fallback_reason: Option<String>,
    /// Added to sink.get_pos() to get the true file position.
    /// Non-zero after a fallback seek: the skipped source's get_pos() starts at 0,
    /// so we add the seek target to recover the real position.
    seek_position_offset: f64,
    /// The cumulative position of the sink when the current track started.
    /// Used to calculate per-track position: sink.get_pos() - sink_baseline_secs.
    sink_baseline_secs: f64,
    /// After a fast seek (try_seek), get_pos() may briefly return 0 before rodio
    /// updates its internal counter. We ignore get_pos() until this instant passes.
    seek_guard_until: Option<Instant>,
}

fn update_output_state(state: &mut AudioPlayerInner, output: &OutputSummary) {
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

fn playback_state_from_inner(state: &AudioPlayerInner, eq_params: &EqParams) -> PlaybackState {
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
    static HOLDING_PLAYER_LOCK: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
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

fn safe_emit<S: serde::Serialize>(app: &AppHandle, event: &str, payload: &S) {
    HOLDING_PLAYER_LOCK.with(|flag| {
        assert!(
            !flag.get(),
            "DEADLOCK RISK: Attempted to emit event '{}' while holding AudioPlayerInner lock on the current thread!",
            event
        );
    });
    let _ = app.emit(event, payload);
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

        // Spawn the dedicated audio thread
        std::thread::spawn(move || {
            // Initialize the audio output device.
            // _stream MUST stay alive for the entire lifetime of audio playback —
            // if it's dropped, all audio stops. The underscore prefix tells Rust
            // "I know I'm not using this variable directly, but don't drop it."
            let mut output = match AudioOutput::open_default() {
                Ok(output) => output,
                Err(e) => {
                    eprintln!("[AudioPlayer] Failed to open audio output: {}", e);
                    return;
                }
            };
            if let Ok(mut state) = inner_clone.lock() {
                update_output_state(&mut state, output.summary());
            }

            // Create the Sink — this is what actually plays audio.
            // connect_new takes a reference to the output stream's mixer.
            let mut sink = match Sink::try_new(output.handle()) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[AudioPlayer] Failed to create audio sink: {}", e);
                    return;
                }
            };

            // Start paused — we'll play when we get a LoadTrack command
            sink.pause();

            // Track the last emitted signature to suppress idle no-op emits.
            // (is_playing, track_id, duration, volume)
            let mut last_emit_sig: Option<(bool, Option<String>, f64, f32)> = None;
            let mut last_progress_emit = Instant::now();

            // Main loop — wait for commands and handle them
            // `recv_timeout` waits for a message OR times out, which lets us
            // periodically emit progress updates even when no commands arrive.
            'audio_loop: loop {
                // Wait up to 50ms for a command. If none arrives, we'll just
                // emit progress and loop again.
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(command) => match command {
                        AudioCommand::LoadTrack(mut path, mut track) => {
                            let mut skipped_loads = 0usize;
                            let mut play_after_load = true;
                            let mut seek_after_load = None;
                            let mut pending_volume: Option<f32> = None;

                            loop {
                                match rx.try_recv() {
                                    Ok(AudioCommand::LoadTrack(next_path, next_track)) => {
                                        path = next_path;
                                        track = next_track;
                                        skipped_loads += 1;
                                    }
                                    Ok(AudioCommand::SetVolume(volume)) => {
                                        // Defer volume change — will be applied to the new sink
                                        pending_volume = Some(volume);
                                        if let Ok(mut state) = inner_clone.lock() {
                                            state.volume = volume;
                                        }
                                    }
                                    Ok(AudioCommand::Pause) => {
                                        play_after_load = false;
                                    }
                                    Ok(AudioCommand::Resume) => {
                                        play_after_load = true;
                                    }
                                    Ok(AudioCommand::Seek(position_secs)) => {
                                        seek_after_load = Some(position_secs);
                                    }
                                    Ok(AudioCommand::Stop) => {
                                        sink.pause();
                                        sink.clear();
                                        if let Ok(mut state) = inner_clone.lock() {
                                            state.is_playing = false;
                                            state.current_track = None;
                                            state.current_path = None;
                                            state.queued_track = None;
                                            state.queued_path = None;
                                            state.position_secs = 0.0;
                                            state.duration_secs = 0.0;
                                            state.sample_rate = 48_000;
                                            state.channels = 2;
                                            state.bits_per_sample = None;
                                            state.seek_position_offset = 0.0;
                                            state.seek_guard_until = None;
                                        }
                                        continue 'audio_loop;
                                    }
                                    Ok(AudioCommand::Shutdown) => break 'audio_loop,
                                    Err(TryRecvError::Empty) => break,
                                    Err(TryRecvError::Disconnected) => break 'audio_loop,
                                }
                            }

                            if skipped_loads > 0 && playback_debug_enabled() {
                                eprintln!(
                                    "[AudioPlayer] Coalesced {skipped_loads} queued track load(s); decoding latest skip target."
                                );
                            }

                            let load_start = Instant::now();
                            debug_log_event(
                                "audio_thread",
                                &format!("load_track processing path={}", path),
                            );

                            // Signal the old sink to stop (atomic flag, instant/non-blocking).
                            // The cpal mixer thread sees stopped=true on its next
                            // callback and cleanly drops the source chain from its own
                            // context. The old sink will be implicitly dropped when
                            // reassigned below.
                            debug_log_event("audio_thread", "Stopping old sink");
                            sink.stop();

                            debug_log_event("audio_thread", "Opening file");
                            let file = match File::open(&path) {
                                Ok(f) => f,
                                Err(e) => {
                                    debug_log_event(
                                        "audio_thread",
                                        &format!("Failed to open file: {e}"),
                                    );
                                    eprintln!(
                                        "[AudioPlayer] Failed to open file '{}': {}",
                                        path, e
                                    );
                                    continue;
                                }
                            };

                            let extension = std::path::Path::new(&path)
                                .extension()
                                .and_then(|ext| ext.to_str());
                            debug_log_event("audio_thread", "Initializing SymphoniaDecoder");
                            let source =
                                match crate::audio::decoder::SymphoniaDecoder::new(file, extension)
                                {
                                    Ok(s) => s,
                                    Err(e) => {
                                        debug_log_event(
                                            "audio_thread",
                                            &format!("Failed to decode file: {e}"),
                                        );
                                        eprintln!(
                                            "[AudioPlayer] Failed to decode '{}': {}",
                                            path, e
                                        );
                                        continue;
                                    }
                                };
                            debug_log_event(
                                "audio_thread",
                                "SymphoniaDecoder initialized successfully",
                            );

                            let source_spec = DecodedTrackSpec {
                                sample_rate: source.sample_rate(),
                                channels: source.channels() as u32,
                                bits_per_sample: source.bits_per_sample(),
                            };
                            debug_log_event(
                                "audio_thread",
                                &format!(
                                    "Track specs: sample_rate={}, channels={}, bits_per_sample={:?}",
                                    source_spec.sample_rate,
                                    source_spec.channels,
                                    source_spec.bits_per_sample
                                ),
                            );

                            if output.is_native_for(source_spec.sample_rate, source_spec.channels) {
                                output.clear_fallback_if_native_for(
                                    source_spec.sample_rate,
                                    source_spec.channels,
                                );
                            } else {
                                debug_log_event(
                                    "audio_thread",
                                    &format!(
                                        "Recreating output for source: old={} Hz/{} ch, new={} Hz/{} ch",
                                        output.summary().sample_rate,
                                        output.summary().channels,
                                        source_spec.sample_rate,
                                        source_spec.channels
                                    ),
                                );
                                match AudioOutput::open_for_source(
                                    source_spec.sample_rate,
                                    source_spec.channels,
                                ) {
                                    Ok(new_output) => {
                                        if let Some(reason) = &new_output.summary().fallback_reason
                                        {
                                            eprintln!("[AudioPlayer] {reason}");
                                        }
                                        output = new_output;
                                    }
                                    Err(err) => {
                                        eprintln!(
                                            "[AudioPlayer] Failed to reopen output for {} Hz / {} ch: {}",
                                            source_spec.sample_rate, source_spec.channels, err
                                        );
                                    }
                                }
                            }
                            let output_summary = output.summary().clone();

                            // Create a fresh sink for the new track
                            debug_log_event("audio_thread", "Creating new Sink for track");
                            sink = match Sink::try_new(output.handle()) {
                                Ok(s) => s,
                                Err(e) => {
                                    debug_log_event(
                                        "audio_thread",
                                        &format!("Failed to create sink: {e}"),
                                    );
                                    eprintln!("[AudioPlayer] Failed to create sink: {e}");
                                    continue;
                                }
                            };
                            sink.pause();

                            // Apply volume to the new sink (deferred from coalescing loop,
                            // or restored from shared state for continuity)
                            if let Some(vol) = pending_volume {
                                sink.set_volume(vol);
                            } else if let Ok(state) = inner_clone.lock() {
                                sink.set_volume(state.volume);
                            }

                            debug_log_event(
                                "audio_thread",
                                "Creating EqSource and appending to sink",
                            );
                            let eq_source = EqSource::new(source, Arc::clone(&eq_params_thread));
                            sink.append(eq_source);
                            debug_log_event("audio_thread", "Source appended to sink");

                            if let Some(position_secs) = seek_after_load {
                                let duration = Duration::from_secs_f64(position_secs.max(0.0));
                                debug_log_event(
                                    "audio_thread",
                                    &format!("Performing initial seek to {}s", position_secs),
                                );
                                if let Err(err) = sink.try_seek(duration) {
                                    debug_log_event(
                                        "audio_thread",
                                        &format!("Initial seek failed: {:?}", err),
                                    );
                                    eprintln!(
                                        "[AudioPlayer] Initial seek to {position_secs:.3}s failed after load: {err:?}"
                                    );
                                }
                            }
                            if play_after_load {
                                debug_log_event("audio_thread", "Playing sink");
                                sink.play();
                            } else {
                                debug_log_event("audio_thread", "Pausing sink");
                                sink.pause();
                            }

                            // Capture baseline after any stop/clear operations.
                            // sink.stop() clears the queue and usually resets position to 0.
                            let current_baseline = sink.get_pos().as_secs_f64();

                            // Update shared state
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = play_after_load;
                                state.current_track = Some(track.as_ref().clone());
                                state.duration_secs = track.duration_secs;
                                state.sink_baseline_secs = current_baseline;
                                state.position_secs = seek_after_load.unwrap_or(0.0);
                                state.current_path = Some(path.clone());
                                state.queued_track = None;
                                state.queued_path = None;
                                state.sample_rate = source_spec.sample_rate;
                                state.channels = source_spec.channels;
                                state.bits_per_sample = source_spec.bits_per_sample;
                                update_output_state(&mut state, &output_summary);
                                state.seek_position_offset = 0.0;
                                state.seek_guard_until = seek_after_load
                                    .map(|_| Instant::now() + Duration::from_millis(50));
                            }

                            if playback_debug_enabled() {
                                eprintln!(
                                    "[AudioPlayer] Loaded '{}' in {:?}.",
                                    track.title,
                                    load_start.elapsed()
                                );
                            }

                            if let Some(next_track) = next_preload_candidate(&app_handle) {
                                let preload_start = Instant::now();
                                let next_path = next_track.file_path.clone();
                                match append_decoded_track(
                                    &sink,
                                    &next_path,
                                    &eq_params_thread,
                                    &output_summary,
                                ) {
                                    Ok(PreloadOutcome::Appended(spec)) => {
                                        if let Ok(mut state) = inner_clone.lock() {
                                            state.queued_path = Some(next_path);
                                            state.queued_track = Some(next_track);
                                            state.queued_sample_rate = Some(spec.sample_rate);
                                            state.queued_channels = Some(spec.channels);
                                            state.queued_bits_per_sample = spec.bits_per_sample;
                                        }
                                        if playback_debug_enabled() {
                                            eprintln!(
                                                "[AudioPlayer] Preloaded next track in {:?}.",
                                                preload_start.elapsed()
                                            );
                                        }
                                    }
                                    Ok(PreloadOutcome::Skipped { spec, reason }) => {
                                        debug_log_event(
                                            "audio_thread",
                                            &format!(
                                                "{reason}; next specs={} Hz/{} ch/{:?}",
                                                spec.sample_rate,
                                                spec.channels,
                                                spec.bits_per_sample
                                            ),
                                        );
                                        if playback_debug_enabled() {
                                            eprintln!("[AudioPlayer] {reason}");
                                        }
                                    }
                                    Err(err) => eprintln!("{err}"),
                                }
                            }
                        }

                        AudioCommand::Pause => {
                            sink.pause();
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = false;
                            }
                        }

                        AudioCommand::Resume => {
                            sink.play();
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = true;
                            }
                        }

                        AudioCommand::Stop => {
                            sink.pause();
                            sink.clear();
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = false;
                                state.current_track = None;
                                state.current_path = None;
                                state.queued_track = None;
                                state.queued_path = None;
                                state.position_secs = 0.0;
                                state.duration_secs = 0.0;
                                state.sample_rate = 48_000;
                                state.channels = 2;
                                state.bits_per_sample = None;
                                state.seek_position_offset = 0.0;
                                state.sink_baseline_secs = 0.0;
                                state.seek_guard_until = None;
                            }
                        }

                        AudioCommand::Seek(position_secs) => {
                            let duration = Duration::from_secs_f64(position_secs.max(0.0));
                            if let Err(e) = sink.try_seek(duration) {
                                eprintln!(
                                    "[AudioPlayer] Fast seek to {:.3}s failed: {:?}; keeping current playback position.",
                                    position_secs, e
                                );
                                if let Ok(mut state) = inner_clone.lock() {
                                    state.seek_guard_until = None;
                                }
                            } else if let Ok(mut state) = inner_clone.lock() {
                                // Fast seek succeeded. get_pos() may return 0 briefly
                                // while rodio's internal position counter catches up.
                                // Guard against that for 50ms.
                                state.position_secs = position_secs;
                                state.seek_position_offset = 0.0;
                                state.seek_guard_until =
                                    Some(Instant::now() + Duration::from_millis(50));
                            }
                        }

                        AudioCommand::SetVolume(volume) => {
                            sink.set_volume(volume);
                            if let Ok(mut state) = inner_clone.lock() {
                                state.volume = volume;
                            }
                        }

                        AudioCommand::Shutdown => break,
                    },

                    // Timeout — no command received in 50ms
                    // This is normal — we use this to update progress
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let mut should_preload_after_promotion = false;
                        let mut promoted_track_id: Option<String> = None;
                        let sink_pos = sink.get_pos().as_secs_f64();
                        let mut state_to_emit = None;

                        if let Ok(mut state) = inner_clone.lock()
                            && state.is_playing
                            && state.queued_track.is_some()
                            && sink.len() == 1
                            && let Some(next_track) = state.queued_track.take()
                        {
                            let next_path = state.queued_path.take();
                            state.current_path = next_path;
                            state.duration_secs = next_track.duration_secs;
                            state.current_track = Some(next_track.clone());
                            state.sample_rate = state.queued_sample_rate.take().unwrap_or(48_000);
                            state.channels = state.queued_channels.take().unwrap_or(2);
                            state.bits_per_sample = state.queued_bits_per_sample.take();

                            // Capture exact sink position at promotion.
                            // sink.get_pos() is cumulative; this baseline is subtracted
                            // from future sink.get_pos() calls to get relative position.
                            state.sink_baseline_secs = sink_pos;
                            state.position_secs = 0.0;
                            state.seek_position_offset = 0.0;
                            state.seek_guard_until = None;

                            if playback_debug_enabled() {
                                eprintln!(
                                    "[AudioPlayer] Gapless promotion: '{}' (baseline={:.3}s, sink_len={})",
                                    next_track.title,
                                    state.sink_baseline_secs,
                                    sink.len()
                                );
                            }

                            promoted_track_id = Some(next_track.id);
                            should_preload_after_promotion = true;

                            // Force an immediate UI update for the track change.
                            state_to_emit =
                                Some(playback_state_from_inner(&state, &eq_params_thread));
                        }

                        if let Some(playback_state) = state_to_emit {
                            safe_emit(&app_handle, "playback-state", &playback_state);
                        }

                        if let Some(track_id) = promoted_track_id {
                            record_play(&app_handle, &track_id);
                            if let Some(queue) = app_handle.try_state::<QueueState>()
                                && let Ok(mut q) = queue.0.lock()
                            {
                                let _ = q.next(false);
                                emit_queue_position_changed(&app_handle, &q);
                            }
                        }

                        if should_preload_after_promotion
                            && let Some(next_track) = next_preload_candidate(&app_handle)
                        {
                            let next_path = next_track.file_path.clone();
                            match append_decoded_track(
                                &sink,
                                &next_path,
                                &eq_params_thread,
                                output.summary(),
                            ) {
                                Ok(PreloadOutcome::Appended(spec)) => {
                                    if let Ok(mut state) = inner_clone.lock() {
                                        state.queued_path = Some(next_path);
                                        state.queued_track = Some(next_track);
                                        state.queued_sample_rate = Some(spec.sample_rate);
                                        state.queued_channels = Some(spec.channels);
                                        state.queued_bits_per_sample = spec.bits_per_sample;
                                    }
                                }
                                Ok(PreloadOutcome::Skipped { spec, reason }) => {
                                    debug_log_event(
                                        "audio_thread",
                                        &format!(
                                            "{reason}; next specs={} Hz/{} ch/{:?}",
                                            spec.sample_rate, spec.channels, spec.bits_per_sample
                                        ),
                                    );
                                }
                                Err(err) => eprintln!("{err}"),
                            }
                        }

                        // Check if the sink has finished playing its current track
                        let mut track_ended = sink.empty();

                        // Failsafe: if rodio doesn't report empty, but we've exceeded duration by 1s
                        if let Ok(state) = inner_clone.lock()
                            && !track_ended
                            && state.is_playing
                            && state.duration_secs > 0.0
                            && state.position_secs >= state.duration_secs + 1.0
                        {
                            track_ended = true;
                        }

                        let mut should_emit_ended = false;
                        if track_ended {
                            if let Ok(mut state) = inner_clone.lock()
                                && state.is_playing
                            {
                                state.is_playing = false;
                                state.position_secs = state.duration_secs;
                                should_emit_ended = true;
                            }
                        } else if let Ok(mut state) = inner_clone.lock()
                            && state.is_playing
                        {
                            if let Some(guard_until) = state.seek_guard_until {
                                // Fast seek: get_pos() may still be 0 while rodio catches up.
                                // Keep position at the seek target until the guard expires.
                                if Instant::now() >= guard_until {
                                    state.seek_guard_until = None;
                                    state.position_secs =
                                        sink.get_pos().as_secs_f64() - state.sink_baseline_secs;
                                }
                                // else: leave position_secs at the seek target
                            } else {
                                // Normal playback or fallback-seek.
                                // seek_position_offset is 0 for normal/fast-seek,
                                // and the seek target for fallback-seek.
                                state.position_secs = state.seek_position_offset
                                    + (sink.get_pos().as_secs_f64() - state.sink_baseline_secs);
                            }
                        }

                        if should_emit_ended {
                            // Notify frontend that the track has ended (use string to avoid null serialization issues)
                            safe_emit(&app_handle, "track-ended", &"ended");
                        }

                        // Emit playback-state at most 5Hz while playing (position advances),
                        // or once when state changes (pause, stop, track switch, volume).
                        // Suppress duplicate emits while idle/paused — avoids jank at 10Hz.
                        //
                        // CRITICAL: A hard minimum gap of 50ms is enforced even for state
                        // changes to prevent WebKitWebProcess from crashing in the GPU
                        // compositor (dri_gbm.so SIGSEGV). During rapid skip-spam, track
                        // changes arrive every ~100ms; without this floor, each change
                        // triggers an immediate WebKit re-render + GPU texture upload,
                        // overwhelming the DRI driver. The deferred state change will be
                        // picked up on the next 50ms tick.
                        let mut state_to_emit = None;
                        if let Ok(state) = inner_clone.lock() {
                            let sig = (
                                state.is_playing,
                                state.current_track.as_ref().map(|t| t.id.clone()),
                                state.duration_secs,
                                state.volume,
                            );
                            let changed = last_emit_sig.as_ref() != Some(&sig);
                            let now = Instant::now();
                            let since_last = now.duration_since(last_progress_emit);
                            // Hard floor: never emit faster than 50ms (20Hz), even on state change.
                            let min_elapsed = since_last >= Duration::from_millis(50);
                            let progress_due = since_last >= Duration::from_millis(200);
                            if min_elapsed && (changed || (state.is_playing && progress_due)) {
                                state_to_emit = Some((
                                    playback_state_from_inner(&state, &eq_params_thread),
                                    sig,
                                    now,
                                ));
                            }
                        }

                        if let Some((playback_state, sig, now)) = state_to_emit {
                            safe_emit(&app_handle, "playback-state", &playback_state);

                            // Update System Media Controls (MPRIS / SMTC)
                            if let Some(controls_state) =
                                app_handle.try_state::<Mutex<souvlaki::MediaControls>>()
                                && let Ok(mut controls) = controls_state.lock()
                            {
                                // Update playback position/status
                                let progress = Some(souvlaki::MediaPosition(
                                    Duration::from_secs_f64(playback_state.position_secs.max(0.0)),
                                ));
                                let playback = if playback_state.is_playing {
                                    souvlaki::MediaPlayback::Playing { progress }
                                } else if playback_state.current_track.is_some() {
                                    souvlaki::MediaPlayback::Paused { progress }
                                } else {
                                    souvlaki::MediaPlayback::Stopped
                                };
                                let _ = controls.set_playback(playback);

                                // Update Metadata if track changed
                                let track_changed =
                                    last_emit_sig.as_ref().and_then(|sig| sig.1.as_ref())
                                        != playback_state.current_track.as_ref().map(|t| &t.id);
                                if track_changed || last_emit_sig.is_none() {
                                    if let Some(ref track) = playback_state.current_track {
                                        let cover_url = mpris_cover_url(&app_handle, track);
                                        let metadata = souvlaki::MediaMetadata {
                                            title: Some(&track.title),
                                            artist: Some(&track.artist),
                                            album: Some(&track.album),
                                            cover_url: cover_url.as_deref(),
                                            duration: Some(Duration::from_secs_f64(
                                                track.duration_secs.max(0.0),
                                            )),
                                        };
                                        let _ = controls.set_metadata(metadata);
                                    } else {
                                        let _ = controls
                                            .set_metadata(souvlaki::MediaMetadata::default());
                                    }
                                }
                            }

                            last_emit_sig = Some(sig);
                            last_progress_emit = now;
                        }
                    }

                    // Channel disconnected — all senders have been dropped
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        break; // Exit the loop
                    }
                }
            }

            // Thread is exiting — sink and _stream will be dropped, releasing audio device
        });

        AudioPlayer {
            command_tx: Mutex::new(tx),
            inner,
            eq_params,
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

    /// Update equalizer parameters. Writes the shared `EqParams` block directly;
    /// the audio thread's `EqSource` picks up the change on its next recheck
    /// (no command round-trip needed). Also works while nothing is playing —
    /// the next loaded track will use the new settings.
    pub fn set_eq(&self, enabled: bool, preamp_db: f32, gains_db: [f32; BAND_COUNT]) {
        self.eq_params.set(enabled, preamp_db, gains_db);
    }

    pub fn set_peq(
        &self,
        enabled: bool,
        preamp_db: f32,
        bands: [(bool, u8, f32, f32, f32); PEQ_BAND_COUNT],
    ) {
        self.eq_params.set_peq(enabled, preamp_db, bands);
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
        if let Ok(tx) = self.command_tx.lock() {
            let _ = tx.send(AudioCommand::Shutdown);
        }
    }
}
