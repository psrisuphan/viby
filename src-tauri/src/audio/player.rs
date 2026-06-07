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
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait};
use rodio::{OutputStream, OutputStreamHandle, Sink, Source, StreamError};
use tauri::{AppHandle, Emitter, Manager};

use crate::audio::eq::{BAND_COUNT, BandConfig, EqParams, EqSource, PEQ_BAND_COUNT};
use crate::models::{PlaybackState, Track};

struct AudioOutput {
    _stream: OutputStream,
    handle: OutputStreamHandle,
    sample_rate: u32,
}

fn open_default_output() -> Result<AudioOutput, StreamError> {
    let sample_rate = cpal::default_host()
        .default_output_device()
        .and_then(|device| device.default_output_config().ok())
        .map(|config| config.sample_rate().0)
        .unwrap_or(0);
    let (_stream, handle) = OutputStream::try_default()?;
    Ok(AudioOutput {
        _stream,
        handle,
        sample_rate,
    })
}

fn sample_format_quality(format: cpal::SampleFormat) -> u8 {
    match format {
        cpal::SampleFormat::F32 => 100,
        cpal::SampleFormat::F64 => 95,
        cpal::SampleFormat::I32 | cpal::SampleFormat::U32 => 90,
        cpal::SampleFormat::I16 | cpal::SampleFormat::U16 => 80,
        cpal::SampleFormat::I8 | cpal::SampleFormat::U8 => 10,
        _ => 50,
    }
}

fn open_output_for_sample_rate(sample_rate: u32) -> Result<AudioOutput, StreamError> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or(StreamError::NoDevice)?;
    let default_config = device
        .default_output_config()
        .map_err(StreamError::DefaultStreamConfigError)?;
    let default_channels = default_config.channels();
    let default_format = default_config.sample_format();
    let supported = device
        .supported_output_configs()
        .map_err(StreamError::SupportedStreamConfigsError)?;

    let mut best = None;
    let mut best_score = (0u8, 0u8, 0u32);
    for range in supported {
        if !(range.min_sample_rate().0 <= sample_rate && sample_rate <= range.max_sample_rate().0) {
            continue;
        }

        let format = range.sample_format();
        let channels = range.channels();
        let score = (
            u8::from(format == default_format),
            sample_format_quality(format),
            u32::from(channels == default_channels) * 10_000 + u32::from(channels),
        );
        if score > best_score {
            best_score = score;
            best = Some(range.with_sample_rate(cpal::SampleRate(sample_rate)));
        }
    }

    if let Some(config) = best {
        let (_stream, handle) = OutputStream::try_from_device_config(&device, config)?;
        Ok(AudioOutput {
            _stream,
            handle,
            sample_rate,
        })
    } else {
        Err(StreamError::NoDevice)
    }
}

fn open_preferred_output(sample_rate: Option<u32>) -> Result<AudioOutput, StreamError> {
    if let Some(sample_rate) = sample_rate
        && sample_rate > 0
    {
        match open_output_for_sample_rate(sample_rate) {
            Ok(output) => return Ok(output),
            Err(err) => {
                eprintln!(
                    "[AudioPlayer] Native output rate {sample_rate} Hz unavailable; using default device rate: {err}"
                );
            }
        }
    }
    open_default_output()
}

// =============================================================================
// AudioCommand — messages we send to the audio thread
// =============================================================================

/// Commands that can be sent to the audio thread.
enum AudioCommand {
    LoadTrack(String),
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
    /// Current position in seconds (updated by the progress timer)
    position_secs: f64,
    /// Total duration of the current track
    duration_secs: f64,
    /// Current volume level (0.0 to 1.0)
    volume: f32,
    /// Sample rate of the currently loaded source, used for EQ/preamp calculations.
    sample_rate: u32,
    /// Added to sink.get_pos() to get the true file position.
    /// Non-zero after a fallback seek: the skipped source's get_pos() starts at 0,
    /// so we add the seek target to recover the real position.
    seek_position_offset: f64,
    /// After a fast seek (try_seek), get_pos() may briefly return 0 before rodio
    /// updates its internal counter. We ignore get_pos() until this instant passes.
    seek_guard_until: Option<Instant>,
}

// =============================================================================
// AudioPlayer — the public API for controlling audio
// =============================================================================

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
    inner: Arc<Mutex<AudioPlayerInner>>,
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
        let inner = Arc::new(Mutex::new(AudioPlayerInner {
            is_playing: false,
            current_track: None,
            current_path: None,
            position_secs: 0.0,
            duration_secs: 0.0,
            volume: 1.0,
            sample_rate: 48_000,
            seek_position_offset: 0.0,
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
            let mut output = match open_preferred_output(None) {
                Ok(output) => output,
                Err(e) => {
                    eprintln!("[AudioPlayer] Failed to open audio output: {}", e);
                    return;
                }
            };

            // Create the Sink — this is what actually plays audio.
            // connect_new takes a reference to the output stream's mixer.
            let mut sink = match Sink::try_new(&output.handle) {
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
            loop {
                // Wait up to 50ms for a command. If none arrives, we'll just
                // emit progress and loop again.
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(command) => match command {
                        AudioCommand::LoadTrack(path) => {
                            // Stop and clear whatever is currently playing
                            sink.stop();

                            // Open the audio file
                            let file = match File::open(&path) {
                                Ok(f) => f,
                                Err(e) => {
                                    eprintln!(
                                        "[AudioPlayer] Failed to open file '{}': {}",
                                        path, e
                                    );
                                    continue;
                                }
                            };

                            // Decode the audio file using our custom SymphoniaDecoder which implements
                            // rodio::Source and supports seeking.
                            let extension = std::path::Path::new(&path)
                                .extension()
                                .and_then(|ext| ext.to_str());
                            let source =
                                match crate::audio::decoder::SymphoniaDecoder::new(file, extension)
                                {
                                    Ok(s) => s,
                                    Err(e) => {
                                        eprintln!(
                                            "[AudioPlayer] Failed to decode '{}': {}",
                                            path, e
                                        );
                                        continue;
                                    }
                                };

                            // After sink.stop(), the old sink is consumed. We need
                            // to create a fresh sink for the new track. But rodio 0.20
                            // doesn't let us reuse a stopped sink. Instead, we can
                            // clear + append on a new sink. However, since we're in a
                            // long-lived thread, let's just clear and re-append.
                            // Actually in rodio 0.20, stop() just clears the queue,
                            // so we can re-append.
                            //
                            // Pipe the f32 source directly through the equalizer.
                            // A flat/disabled EQ is bit-transparent (see eq.rs).
                            let source_sample_rate = source.sample_rate();
                            if output.sample_rate != source_sample_rate {
                                match open_output_for_sample_rate(source_sample_rate) {
                                    Ok(new_output) => {
                                        output = new_output;
                                        match Sink::try_new(&output.handle) {
                                            Ok(new_sink) => {
                                                sink = new_sink;
                                                sink.pause();
                                            }
                                            Err(err) => {
                                                eprintln!(
                                                    "[AudioPlayer] Failed to create native-rate sink: {err}"
                                                );
                                            }
                                        }
                                    }
                                    Err(err) => {
                                        eprintln!(
                                            "[AudioPlayer] Native output rate {} Hz unavailable for this track; using current/default stream: {}",
                                            source_sample_rate, err
                                        );
                                    }
                                }
                            }
                            let eq_source = EqSource::new(source, Arc::clone(&eq_params_thread));
                            sink.append(eq_source);
                            sink.play();

                            // Update shared state
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = true;
                                state.position_secs = 0.0;
                                state.current_path = Some(path.clone());
                                state.sample_rate = source_sample_rate;
                                state.seek_position_offset = 0.0;
                                state.seek_guard_until = None;
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
                            sink.stop();
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = false;
                                state.current_track = None;
                                state.current_path = None;
                                state.position_secs = 0.0;
                                state.duration_secs = 0.0;
                                state.sample_rate = 48_000;
                                state.seek_position_offset = 0.0;
                                state.seek_guard_until = None;
                            }
                        }

                        AudioCommand::Seek(position_secs) => {
                            let duration = Duration::from_secs_f64(position_secs);
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

                        if track_ended {
                            if let Ok(mut state) = inner_clone.lock()
                                && state.is_playing
                            {
                                state.is_playing = false;
                                // Notify frontend that the track has ended (use string to avoid null serialization issues)
                                let _ = app_handle.emit("track-ended", "ended");
                            }
                        } else if let Ok(mut state) = inner_clone.lock()
                            && state.is_playing
                        {
                            if let Some(guard_until) = state.seek_guard_until {
                                // Fast seek: get_pos() may still be 0 while rodio catches up.
                                // Keep position at the seek target until the guard expires.
                                if Instant::now() >= guard_until {
                                    state.seek_guard_until = None;
                                    state.position_secs = sink.get_pos().as_secs_f64();
                                }
                                // else: leave position_secs at the seek target
                            } else {
                                // Normal playback or fallback-seek.
                                // seek_position_offset is 0 for normal/fast-seek,
                                // and the seek target for fallback-seek.
                                state.position_secs =
                                    state.seek_position_offset + sink.get_pos().as_secs_f64();
                            }
                        }

                        // Emit playback-state every tick while playing (position advances),
                        // or once when state changes (pause, stop, track switch, volume).
                        // Suppress duplicate emits while idle/paused — avoids 4Hz re-renders.
                        if let Ok(state) = inner_clone.lock() {
                            let sig = (
                                state.is_playing,
                                state.current_track.as_ref().map(|t| t.id.clone()),
                                state.duration_secs,
                                state.volume,
                            );
                            let changed = last_emit_sig.as_ref() != Some(&sig);
                            let now = Instant::now();
                            let progress_due = now.duration_since(last_progress_emit)
                                >= Duration::from_millis(300);
                            if changed || (state.is_playing && progress_due) {
                                last_progress_emit = now;
                                let playback_state = PlaybackState {
                                    is_playing: state.is_playing,
                                    current_track: state.current_track.clone(),
                                    position_secs: state.position_secs,
                                    duration_secs: state.duration_secs,
                                    volume: state.volume,
                                    shuffle: false,
                                    repeat_mode: "off".to_string(),
                                };
                                let _ = app_handle.emit("playback-state", &playback_state);

                                // Update System Media Controls (MPRIS / SMTC)
                                if let Some(controls_state) =
                                    app_handle.try_state::<Mutex<souvlaki::MediaControls>>()
                                    && let Ok(mut controls) = controls_state.lock() {
                                        // Update playback position/status
                                        let progress = Some(souvlaki::MediaPosition(
                                            Duration::from_secs_f64(state.position_secs),
                                        ));
                                        let playback = if state.is_playing {
                                            souvlaki::MediaPlayback::Playing { progress }
                                        } else if state.current_track.is_some() {
                                            souvlaki::MediaPlayback::Paused { progress }
                                        } else {
                                            souvlaki::MediaPlayback::Stopped
                                        };
                                        let _ = controls.set_playback(playback);

                                        // Update Metadata if track changed
                                        let track_changed =
                                            last_emit_sig.as_ref().and_then(|sig| sig.1.as_ref())
                                                != state.current_track.as_ref().map(|t| &t.id);
                                        if track_changed || last_emit_sig.is_none() {
                                            if let Some(ref track) = state.current_track {
                                                let cover_url =
                                                    save_mpris_artwork(&app_handle, track);
                                                let metadata = souvlaki::MediaMetadata {
                                                    title: Some(&track.title),
                                                    artist: Some(&track.artist),
                                                    album: Some(&track.album),
                                                    cover_url: cover_url.as_deref(),
                                                    duration: Some(Duration::from_secs_f64(
                                                        track.duration_secs,
                                                    )),
                                                };
                                                let _ = controls.set_metadata(metadata);
                                            } else {
                                                let _ = controls.set_metadata(
                                                    souvlaki::MediaMetadata::default(),
                                                );
                                            }
                                        }
                                    }

                                last_emit_sig = Some(sig);
                            }
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
        if let Ok(mut state) = self.inner.lock() {
            state.current_track = Some(track.clone());
            state.duration_secs = track.duration_secs;
            state.position_secs = 0.0;
        }
        self.send(AudioCommand::LoadTrack(path.to_string()));
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
            PlaybackState {
                is_playing: state.is_playing,
                current_track: state.current_track.clone(),
                position_secs: state.position_secs,
                duration_secs: state.duration_secs,
                volume: state.volume,
                shuffle: false,
                repeat_mode: "off".to_string(),
            }
        } else {
            // If lock fails (extremely rare), return a default state
            PlaybackState {
                is_playing: false,
                current_track: None,
                position_secs: 0.0,
                duration_secs: 0.0,
                volume: 1.0,
                shuffle: false,
                repeat_mode: "off".to_string(),
            }
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

/// Helper function to extract and save the artwork of a track to a local file,
/// returning the file:// URI for MPRIS.
fn save_mpris_artwork(app: &tauri::AppHandle, track: &Track) -> Option<String> {
    let app_data_dir = app.path().app_data_dir().ok()?;
    let art_dir = app_data_dir.join("mpris_art");
    if !art_dir.exists() {
        let _ = std::fs::create_dir_all(&art_dir);
    }

    let album_key = format!("{}||{}", track.album, track.album_artist);
    let safe_key: String = album_key
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '_' })
        .collect();

    // Check if we already have it saved as .png or .jpg
    let png_path = art_dir.join(format!("{}.png", safe_key));
    if png_path.exists() {
        return Some(format!("file://{}", png_path.to_str()?));
    }
    let jpg_path = art_dir.join(format!("{}.jpg", safe_key));
    if jpg_path.exists() {
        return Some(format!("file://{}", jpg_path.to_str()?));
    }

    // Try to extract metadata
    let meta = crate::library::metadata::extract_metadata(&track.file_path).ok()?;

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
                        && let Ok(bytes) = std::fs::read(entry.path()) {
                            return Some(bytes);
                        }
                }
            }
        }
        None
    })?;

    let ext = if artwork_bytes.starts_with(b"\x89PNG") {
        "png"
    } else {
        "jpg"
    };

    let target_path = art_dir.join(format!("{}.{}", safe_key, ext));
    if std::fs::write(&target_path, &artwork_bytes).is_ok() {
        Some(format!("file://{}", target_path.to_str()?))
    } else {
        None
    }
}
