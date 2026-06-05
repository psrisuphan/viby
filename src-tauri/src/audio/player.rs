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
use std::io::BufReader;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::{OutputStream, Sink};
use tauri::{AppHandle, Emitter};

use crate::models::{PlaybackState, Track};

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
        }));

        // Clone the Arc so the audio thread gets its own reference
        // (Arc cloning is cheap — it just increments a counter)
        let inner_clone = Arc::clone(&inner);

        // Spawn the dedicated audio thread
        std::thread::spawn(move || {
            // Initialize the audio output device.
            // _stream MUST stay alive for the entire lifetime of audio playback —
            // if it's dropped, all audio stops. The underscore prefix tells Rust
            // "I know I'm not using this variable directly, but don't drop it."
            let (_stream, stream_handle) = match OutputStream::try_default() {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[AudioPlayer] Failed to open audio output: {}", e);
                    return;
                }
            };

            // Create the Sink — this is what actually plays audio.
            // connect_new takes a reference to the output stream's mixer.
            let sink = match Sink::try_new(&stream_handle) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[AudioPlayer] Failed to create audio sink: {}", e);
                    return;
                }
            };

            // Start paused — we'll play when we get a LoadTrack command
            sink.pause();

            // Main loop — wait for commands and handle them
            // `recv_timeout` waits for a message OR times out, which lets us
            // periodically emit progress updates even when no commands arrive.
            loop {
                // Wait up to 250ms for a command. If none arrives, we'll just
                // emit progress and loop again.
                match rx.recv_timeout(Duration::from_millis(250)) {
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

                            // Decode the audio file. BufReader adds buffering for
                            // better I/O performance (like streams in Node.js).
                            let reader = BufReader::new(file);
                            let source = match rodio::Decoder::new(reader) {
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
                            sink.append(source);
                            sink.play();

                            // Update shared state
                            if let Ok(mut state) = inner_clone.lock() {
                                state.is_playing = true;
                                state.position_secs = 0.0;
                                state.current_path = Some(path.clone());
                                // Duration will be read from metadata (set by command handler)
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
                            }
                        }

                        AudioCommand::Seek(position_secs) => {
                            let duration = Duration::from_secs_f64(position_secs);
                            if let Err(e) = sink.try_seek(duration) {
                                eprintln!("[AudioPlayer] Fast seek failed: {:?}. Using fallback skip...", e);
                                
                                // Fallback: reopen file, decode, and use skip_duration
                                let path = inner_clone.lock().unwrap().current_path.clone();
                                if let Some(path) = path {
                                    if let Ok(file) = File::open(&path) {
                                        let reader = BufReader::new(file);
                                        if let Ok(source) = rodio::Decoder::new(reader) {
                                            use rodio::Source;
                                            sink.stop(); // Clear current
                                            let skipped = source.skip_duration(duration);
                                            sink.append(skipped);
                                            sink.play();
                                            if let Ok(mut state) = inner_clone.lock() {
                                                state.position_secs = position_secs;
                                                // Make sure we're marked as playing since we resumed
                                                state.is_playing = true;
                                            }
                                        }
                                    }
                                }
                            } else if let Ok(mut state) = inner_clone.lock() {
                                state.position_secs = position_secs;
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

                    // Timeout — no command received in 250ms
                    // This is normal — we use this to update progress
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Check if the sink has finished playing its current track
                        let mut track_ended = sink.empty();
                        
                        // Failsafe: if rodio doesn't report empty, but we've exceeded duration by 1s
                        if let Ok(state) = inner_clone.lock() {
                            if !track_ended && state.is_playing && state.duration_secs > 0.0 && state.position_secs >= state.duration_secs + 1.0 {
                                track_ended = true;
                            }
                        }

                        if track_ended {
                            if let Ok(mut state) = inner_clone.lock() {
                                if state.is_playing {
                                    state.is_playing = false;
                                    // Notify frontend that the track has ended (use string to avoid null serialization issues)
                                    let _ = app_handle.emit("track-ended", "ended");
                                }
                            }
                        } else if let Ok(mut state) = inner_clone.lock() {
                            // Use the sink's actual playback position instead of a counter
                            // so the progress bar stays accurate after seeks and never drifts.
                            if state.is_playing {
                                state.position_secs = sink.get_pos().as_secs_f64();
                            }
                        }

                        // ALWAYS emit progress update to frontend, even if empty,
                        // so frontend knows when current_track becomes None!
                        if let Ok(state) = inner_clone.lock() {
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
        self.inner
            .lock()
            .map(|s| s.is_playing)
            .unwrap_or(false)
    }

    fn send(&self, cmd: AudioCommand) {
        if let Ok(tx) = self.command_tx.lock() {
            if tx.send(cmd).is_err() {
                eprintln!("[AudioPlayer] Audio thread is no longer running — command dropped.");
            }
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
