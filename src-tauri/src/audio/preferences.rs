use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex};

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
    initialized: bool,
}

enum PersistenceMessage {
    Update(PlaybackPreferences),
    Flush(Sender<Result<(), String>>),
}

#[derive(Clone)]
pub struct PlaybackPreferencesStore {
    path: Arc<PathBuf>,
    state: Arc<Mutex<StoreState>>,
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
                initialized,
            })),
            persistence_tx,
        }
    }

    pub fn snapshot(&self) -> PlaybackPreferences {
        self.state
            .lock()
            .map(|state| state.preferences.clone())
            .unwrap_or_default()
    }

    /// Import the previous frontend-owned preferences only when no backend file exists.
    pub fn initialize(
        &self,
        legacy: Option<PlaybackPreferences>,
    ) -> Result<(PlaybackPreferences, bool), String> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| format!("Playback preferences lock failed: {error}"))?;
        if state.initialized {
            return Ok((state.preferences.clone(), false));
        }

        let preferences = legacy.unwrap_or_default().normalized();
        persist(&self.path, &preferences)?;
        state.preferences = preferences.clone();
        state.initialized = true;
        Ok((preferences, true))
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
            .recv()
            .map_err(|error| format!("Playback preferences flush failed: {error}"))?
    }

    fn update(&self, update: impl FnOnce(&mut PlaybackPreferences)) {
        let snapshot = {
            let Ok(mut state) = self.state.lock() else {
                eprintln!("[PlaybackPreferences] Preferences lock was poisoned");
                return;
            };
            let previous = state.preferences.clone();
            update(&mut state.preferences);
            if previous == state.preferences && state.initialized {
                return;
            }
            state.initialized = true;
            state.preferences.clone()
        };
        if let Err(error) = self
            .persistence_tx
            .send(PersistenceMessage::Update(snapshot))
        {
            eprintln!("[PlaybackPreferences] Could not queue preferences persistence: {error}");
        }
    }
}

fn persistence_worker(path: Arc<PathBuf>, receiver: Receiver<PersistenceMessage>) {
    while let Ok(message) = receiver.recv() {
        let mut latest = match message {
            PersistenceMessage::Update(preferences) => Some(preferences),
            PersistenceMessage::Flush(done) => {
                let _ = done.send(Ok(()));
                continue;
            }
        };

        loop {
            match receiver.try_recv() {
                Ok(PersistenceMessage::Update(preferences)) => latest = Some(preferences),
                Ok(PersistenceMessage::Flush(done)) => {
                    let result = latest
                        .take()
                        .map(|preferences| persist(&path, &preferences))
                        .unwrap_or(Ok(()));
                    let _ = done.send(result);
                    break;
                }
                Err(TryRecvError::Empty) => {
                    if let Some(preferences) = latest.take()
                        && let Err(error) = persist(&path, &preferences)
                    {
                        eprintln!("[PlaybackPreferences] Could not persist preferences: {error}");
                    }
                    break;
                }
                Err(TryRecvError::Disconnected) => {
                    if let Some(preferences) = latest.take()
                        && let Err(error) = persist(&path, &preferences)
                    {
                        eprintln!("[PlaybackPreferences] Could not persist preferences: {error}");
                    }
                    return;
                }
            }
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
        drop(store);

        let restarted = PlaybackPreferencesStore::open(&path);
        let (restored, applied_stale_legacy) = restarted
            .initialize(Some(PlaybackPreferences::default()))
            .expect("persisted controls should load");
        assert!(!applied_stale_legacy);
        assert_eq!(restored, migrated);

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
}
