use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

pub(crate) struct OpenFilesWorker(
    pub(crate) std::sync::mpsc::Sender<(tauri::AppHandle, Vec<std::path::PathBuf>)>,
);

pub struct ArtworkCache {
    pub entries: HashMap<String, Option<(Vec<u8>, String)>>,
    pub order: VecDeque<String>,
    pub max_entries: usize,
    pub max_bytes: usize,
    pub current_bytes: usize,
}

pub(crate) fn claim_artwork_fetch(in_flight: &mut std::collections::HashSet<String>, key: &str) -> bool {
    in_flight.insert(key.to_string())
}

pub(crate) fn release_artwork_fetch(
    in_flight: &mut std::collections::HashSet<String>,
    key: &str,
) {
    in_flight.remove(key);
}

impl ArtworkCache {
    pub fn get(&self, key: &str) -> Option<Option<(Vec<u8>, String)>> {
        self.entries.get(key).cloned()
    }

    pub fn insert(&mut self, key: String, value: Option<(Vec<u8>, String)>) {
        let value_bytes = value.as_ref().map_or(0, |(bytes, _)| bytes.len());
        if value_bytes > self.max_bytes {
            return;
        }

        if let Some(previous) = self.entries.remove(&key) {
            self.current_bytes = self
                .current_bytes
                .saturating_sub(previous.as_ref().map_or(0, |(bytes, _)| bytes.len()));
            self.order.retain(|existing| existing != &key);
        }

        while self.entries.len() >= self.max_entries
            || self.current_bytes.saturating_add(value_bytes) > self.max_bytes
        {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(previous) = self.entries.remove(&oldest) {
                self.current_bytes = self
                    .current_bytes
                    .saturating_sub(previous.as_ref().map_or(0, |(bytes, _)| bytes.len()));
            }
        }

        self.current_bytes += value_bytes;
        self.order.push_back(key.clone());
        self.entries.insert(key, value);
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.order.clear();
        self.current_bytes = 0;
    }
}

pub struct ScanLock(pub AtomicBool);

impl ScanLock {
    pub fn try_acquire(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct NormalizationAnalysisLock(pub AtomicBool);

impl NormalizationAnalysisLock {
    pub fn try_acquire(&self) -> bool {
        self.0
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn release(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

pub struct DiscordRpcEnabled(pub AtomicBool);

pub struct DiscordRpcQualityEnabled(pub AtomicBool);

pub struct FrontendVisible(pub AtomicBool);

pub struct RendererLifecycleState {
    pub(crate) enabled: AtomicBool,
    pub(crate) terminated: AtomicBool,
    pub(crate) restoring: AtomicBool,
    pub(crate) generation: AtomicU64,
}

impl RendererLifecycleState {
    pub(crate) fn new() -> Self {
        Self {
            enabled: AtomicBool::new(cfg!(target_os = "linux")),
            terminated: AtomicBool::new(false),
            restoring: AtomicBool::new(false),
            generation: AtomicU64::new(0),
        }
    }
}
