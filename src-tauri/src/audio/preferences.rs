use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackPreferences {
    pub volume: f32,
    pub is_muted: bool,
    pub previous_volume: f32,
    pub shuffle: bool,
    pub repeat_mode: String,
}

impl Default for PlaybackPreferences {
    fn default() -> Self {
        Self {
            volume: 1.0,
            is_muted: false,
            previous_volume: 1.0,
            shuffle: false,
            repeat_mode: "off".to_string(),
        }
    }
}

impl PlaybackPreferences {
    fn normalized(mut self) -> Self {
        self.volume = normalized_volume(self.volume).unwrap_or(1.0);
        self.previous_volume = normalized_volume(self.previous_volume)
            .filter(|volume| *volume > 0.0)
            .unwrap_or(if self.volume > 0.0 { self.volume } else { 1.0 });
        self.is_muted |= self.volume == 0.0;
        if self.is_muted {
            self.volume = 0.0;
        }
        if !matches!(self.repeat_mode.as_str(), "off" | "one" | "all") {
            self.repeat_mode = "off".to_string();
        }
        self
    }
}

struct StoreState {
    preferences: PlaybackPreferences,
    durable_initialized: bool,
    runtime_ready: bool,
}

enum PersistenceMessage {
    Update(PlaybackPreferences),
    Flush(Sender<Result<(), String>>),
}

#[derive(Clone)]
pub struct PlaybackPreferencesStore {
    path: Arc<PathBuf>,
    state: Arc<Mutex<StoreState>>,
    control_lock: Arc<Mutex<()>>,
    persistence_tx: Sender<PersistenceMessage>,
}

impl PlaybackPreferencesStore {
    pub fn open(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let (preferences, initialized) = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<PlaybackPreferences>(&bytes) {
                Ok(preferences) => (preferences.normalized(), true),
                Err(error) => {
                    eprintln!("[PlaybackPreferences] Ignoring invalid preferences file: {error}");
                    (PlaybackPreferences::default(), false)
                }
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (PlaybackPreferences::default(), false)
            }
            Err(error) => {
                eprintln!("[PlaybackPreferences] Could not read preferences file: {error}");
                (PlaybackPreferences::default(), false)
            }
        };

        let path = Arc::new(path);
        let (persistence_tx, persistence_rx) = mpsc::channel();
        let persistence_path = Arc::clone(&path);
        std::thread::spawn(move || persistence_worker(persistence_path, persistence_rx));

        Self {
            path,
            state: Arc::new(Mutex::new(StoreState {
                preferences,
                durable_initialized: initialized,
                runtime_ready: false,
            })),
            control_lock: Arc::new(Mutex::new(())),
            persistence_tx,
        }
    }

    /// Serialize initialization with commands that change persisted playback controls.
    pub fn lock_controls(&self) -> Result<MutexGuard<'_, ()>, String> {
        self.control_lock
            .lock()
            .map_err(|error| format!("Playback control lock failed: {error}"))
    }

    /// Reject control changes until startup has acknowledged runtime restoration.
    pub fn ensure_initialized(&self) -> Result<(), String> {
        let state = self
            .state
            .lock()
            .map_err(|error| format!("Playback preferences lock failed: {error}"))?;
        if state.runtime_ready {
            Ok(())
        } else {
            Err("Playback preferences are not ready".to_string())
        }
    }

    /// Mark startup complete only after volume and queue modes were applied.
    pub fn mark_runtime_ready(&self) -> Result<(), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("Playback preferences lock failed: {error}"))?;
        if !state.durable_initialized {
            return Err("Playback preferences are not durably initialized".to_string());
        }
        state.runtime_ready = true;
        Ok(())
    }

    pub fn snapshot(&self) -> PlaybackPreferences {
        self.state
            .lock()
            .map(|state| state.preferences.clone())
            .unwrap_or_default()
    }

    /// Load or migrate preferences and report whether runtime settings still need applying.
    pub fn initialize(
        &self,
        legacy: Option<PlaybackPreferences>,
    ) -> Result<(PlaybackPreferences, bool), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("Playback preferences lock failed: {error}"))?;
        if state.runtime_ready {
            return Ok((state.preferences.clone(), false));
        }

        if !state.durable_initialized {
            let preferences = legacy.unwrap_or_default().normalized();
            persist(&self.path, &preferences)?;
            state.preferences = preferences;
            state.durable_initialized = true;
        }
        Ok((state.preferences.clone(), true))
    }

    pub fn update_volume(&self, volume: f32, is_muted: bool, previous_volume: f32) {
        self.update(|preferences| {
            preferences.volume = normalized_volume(volume).unwrap_or(1.0);
            preferences.is_muted = is_muted || preferences.volume == 0.0;
            if preferences.is_muted {
                preferences.volume = 0.0;
            }
            let current_previous_volume = preferences.previous_volume;
            preferences.previous_volume = normalized_volume(previous_volume)
                .filter(|value| *value > 0.0)
                .unwrap_or(if current_previous_volume > 0.0 {
                    current_previous_volume
                } else {
                    1.0
                });
        });
    }

    pub fn set_shuffle(&self, shuffle: bool) {
        self.update(|preferences| preferences.shuffle = shuffle);
    }

    pub fn set_repeat_mode(&self, repeat_mode: &str) {
        let repeat_mode = if matches!(repeat_mode, "off" | "one" | "all") {
            repeat_mode.to_string()
        } else {
            "off".to_string()
        };
        self.update(|preferences| preferences.repeat_mode = repeat_mode);
    }

    pub fn flush(&self) -> Result<(), String> {
        let (done_tx, done_rx) = mpsc::channel();
        self.persistence_tx
            .send(PersistenceMessage::Flush(done_tx))
            .map_err(|error| format!("Playback preferences writer stopped: {error}"))?;
        done_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|error| format!("Playback preferences flush failed: {error}"))?
    }

    fn update(&self, update: impl FnOnce(&mut PlaybackPreferences)) {
        let Ok(mut state) = self.state.lock() else {
            eprintln!("[PlaybackPreferences] Preferences lock was poisoned");
            return;
        };
        let previous = state.preferences.clone();
        update(&mut state.preferences);
        if previous == state.preferences && state.durable_initialized {
            return;
        }
        let snapshot = state.preferences.clone();
        // Keep enqueue order aligned with the state mutation order. The channel is
        // unbounded, so send does not wait for disk I/O while holding this lock.
        if let Err(error) = self
            .persistence_tx
            .send(PersistenceMessage::Update(snapshot))
        {
            eprintln!("[PlaybackPreferences] Could not queue preferences persistence: {error}");
        }
    }
}

fn persistence_worker(path: Arc<PathBuf>, receiver: Receiver<PersistenceMessage>) {
    let mut last_error: Option<String> = None;
    while let Ok(message) = receiver.recv() {
        let mut latest = match message {
            PersistenceMessage::Update(preferences) => preferences,
            PersistenceMessage::Flush(done) => {
                let _ = done.send(last_error.clone().map_or(Ok(()), Err));
                continue;
            }
        };

        loop {
            match receiver.try_recv() {
                Ok(PersistenceMessage::Update(preferences)) => latest = preferences,
                Ok(PersistenceMessage::Flush(done)) => {
                    let result = persist_and_record(&path, &latest, &mut last_error);
                    let _ = done.send(result);
                    break;
                }
                Err(TryRecvError::Empty) => {
                    let _ = persist_and_record(&path, &latest, &mut last_error);
                    break;
                }
                Err(TryRecvError::Disconnected) => {
                    let _ = persist_and_record(&path, &latest, &mut last_error);
                    return;
                }
            }
        }
    }
}

fn persist_and_record(
    path: &Path,
    preferences: &PlaybackPreferences,
    last_error: &mut Option<String>,
) -> Result<(), String> {
    match persist(path, preferences) {
        Ok(()) => {
            *last_error = None;
            Ok(())
        }
        Err(error) => {
            eprintln!("[PlaybackPreferences] Could not persist preferences: {error}");
            *last_error = Some(error.clone());
            Err(error)
        }
    }
}

fn normalized_volume(value: f32) -> Option<f32> {
    value.is_finite().then(|| value.clamp(0.0, 1.0))
}

fn persist(path: &Path, preferences: &PlaybackPreferences) -> Result<(), String> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|error| format!("Could not create preferences directory: {error}"))?;
    let temporary = path.with_extension("json.tmp");
    let mut file = File::create(&temporary)
        .map_err(|error| format!("Could not create preferences temp file: {error}"))?;
    serde_json::to_writer(&mut file, preferences)
        .map_err(|error| format!("Could not encode playback preferences: {error}"))?;
    file.write_all(b"\n")
        .map_err(|error| format!("Could not finish preferences temp file: {error}"))?;
    file.sync_all()
        .map_err(|error| format!("Could not flush preferences temp file: {error}"))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("Could not replace playback preferences file: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{PlaybackPreferences, PlaybackPreferencesStore};
    use std::fs;
    use std::sync::{Arc, Barrier, mpsc};
    use std::thread;

    fn preferences_path() -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "viby-playback-preferences-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    fn legacy_preferences() -> PlaybackPreferences {
        PlaybackPreferences {
            volume: 0.35,
            is_muted: true,
            previous_volume: 0.35,
            shuffle: true,
            repeat_mode: "all".to_string(),
        }
    }

    #[test]
    fn legacy_controls_migrate_once_and_survive_restart_with_previous_volume() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        let (migrated, applied) = store
            .initialize(Some(legacy_preferences()))
            .expect("legacy controls should migrate");

        assert!(applied);
        assert_eq!(migrated.volume, 0.0);
        assert!(migrated.is_muted);
        assert_eq!(migrated.previous_volume, 0.35);
        assert!(migrated.shuffle);
        assert_eq!(migrated.repeat_mode, "all");
        store
            .mark_runtime_ready()
            .expect("startup should mark runtime settings applied");
        drop(store);

        let restarted = PlaybackPreferencesStore::open(&path);
        let (restored, applied_stale_legacy) = restarted
            .initialize(Some(PlaybackPreferences::default()))
            .expect("persisted controls should load");
        assert!(
            applied_stale_legacy,
            "runtime settings must apply after restart"
        );
        assert_eq!(restored, migrated);
        restarted
            .mark_runtime_ready()
            .expect("restarted runtime settings should be applied");

        restarted.update_volume(0.0, true, restored.previous_volume);
        restarted.flush().expect("volume preferences should flush");
        drop(restarted);
        let after_mute_restart = PlaybackPreferencesStore::open(&path).snapshot();
        assert!(after_mute_restart.is_muted);
        assert_eq!(after_mute_restart.previous_volume, 0.35);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn invalid_legacy_values_are_normalized_before_persistence() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        let mut legacy = legacy_preferences();
        legacy.volume = f32::NAN;
        legacy.is_muted = false;
        legacy.previous_volume = -1.0;
        legacy.repeat_mode = "invalid".to_string();

        let (normalized, _) = store
            .initialize(Some(legacy))
            .expect("normalized controls should persist");

        assert_eq!(normalized.volume, 1.0);
        assert_eq!(normalized.previous_volume, 1.0);
        assert_eq!(normalized.repeat_mode, "off");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn runtime_control_updates_are_durable_after_restart() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        store
            .initialize(None)
            .expect("default preferences should initialize");
        store
            .mark_runtime_ready()
            .expect("runtime settings should be marked applied");
        store.update_volume(0.2, false, 0.2);
        store.set_shuffle(true);
        store.set_repeat_mode("one");
        store.flush().expect("runtime preferences should flush");
        drop(store);

        let restarted = PlaybackPreferencesStore::open(&path);
        let restored = restarted.snapshot();
        assert_eq!(restored.volume, 0.2);
        assert_eq!(restored.previous_volume, 0.2);
        assert!(restored.shuffle);
        assert_eq!(restored.repeat_mode, "one");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn concurrent_control_updates_persist_the_latest_store_snapshot() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        store
            .initialize(None)
            .expect("preferences should initialize");
        store
            .mark_runtime_ready()
            .expect("runtime settings should be marked applied");

        let start = Arc::new(Barrier::new(9));
        let mut workers = Vec::new();
        for index in 0..8 {
            let store = store.clone();
            let start = Arc::clone(&start);
            workers.push(thread::spawn(move || {
                start.wait();
                let volume = index as f32 / 10.0;
                store.update_volume(volume, false, volume.max(0.1));
            }));
        }
        start.wait();
        for worker in workers {
            worker.join().expect("control update worker should finish");
        }

        let expected = store.snapshot();
        store
            .flush()
            .expect("latest preference update should persist");
        let persisted: PlaybackPreferences = serde_json::from_slice(
            &fs::read(&path).expect("persisted preferences should be readable"),
        )
        .expect("persisted preferences should be valid JSON");
        assert_eq!(persisted, expected);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn startup_gate_serializes_initialization_before_control_changes() {
        let path = preferences_path();
        let store = PlaybackPreferencesStore::open(&path);
        assert!(store.ensure_initialized().is_err());
        let startup_guard = store.lock_controls().expect("control gate should lock");
        let worker_store = store.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            started_tx.send(()).unwrap();
            let _controls = worker_store
                .lock_controls()
                .expect("control gate should unlock");
            worker_store.ensure_initialized()?;
            worker_store.set_shuffle(true);
            Ok::<_, String>(())
        });

        started_rx.recv().expect("control worker should start");
        let (restored, apply_runtime) = store.initialize(None).expect("startup should initialize");
        assert!(apply_runtime);
        store
            .mark_runtime_ready()
            .expect("startup runtime settings should apply before controls");
        drop(startup_guard);
        worker
            .join()
            .expect("control worker should finish")
            .unwrap();

        assert!(store.snapshot().shuffle);
        assert_eq!(store.snapshot().volume, restored.volume);
        store.flush().expect("control change should persist");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn flush_reports_async_writer_failure_and_later_success_clears_it() {
        let blocked_parent = std::env::temp_dir().join(format!(
            "viby-playback-preferences-blocked-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&blocked_parent).expect("preference directory should be created");
        let path = blocked_parent.join("preferences.json");
        let store = PlaybackPreferencesStore::open(&path);
        store
            .initialize(None)
            .expect("initial preferences should persist");
        store
            .mark_runtime_ready()
            .expect("runtime settings should be marked applied");

        fs::remove_dir_all(&blocked_parent).expect("preference directory should be removable");
        fs::write(&blocked_parent, b"blocks directory creation")
            .expect("blocker file should write");
        store.update_volume(0.4, false, 0.4);
        assert!(
            store.flush().is_err(),
            "flush must surface the async write failure"
        );

        fs::remove_file(&blocked_parent).expect("blocker file should be removable");
        fs::create_dir_all(&blocked_parent).expect("preference directory should recover");
        store.update_volume(0.7, false, 0.7);
        store
            .flush()
            .expect("successful retry should clear the previous writer error");
        drop(store);
        let _ = fs::remove_dir_all(blocked_parent);
    }
}
