use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 1000;
// Negative hits (confirmed not found) are cached for 30 days so we don't spam
// the iTunes API on every play of a track with no album art on iTunes.
const NOT_FOUND_TTL_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Serialize, Deserialize, Clone)]
pub struct CacheEntry {
    pub url: Option<String>,
    pub fetched_at: u64,
}

impl CacheEntry {
    fn is_valid(&self) -> bool {
        if self.url.is_some() {
            return true; // Positive hits never expire
        }
        let now = unix_now();
        now.saturating_sub(self.fetched_at) < NOT_FOUND_TTL_SECS
    }
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

struct Inner {
    entries: HashMap<String, CacheEntry>,
    // FIFO insertion order for bounded eviction
    order: VecDeque<String>,
    cache_file: PathBuf,
}

impl Inner {
    fn load(cache_file: PathBuf) -> Self {
        let entries = std::fs::read_to_string(&cache_file)
            .ok()
            .and_then(|s| serde_json::from_str::<HashMap<String, CacheEntry>>(&s).ok())
            .unwrap_or_default();
        let order: VecDeque<String> = entries.keys().cloned().collect();
        Self {
            entries,
            order,
            cache_file,
        }
    }

    // Returns:
    //   Some(Some(url)) — positive cache hit, use the URL
    //   Some(None)      — negative hit still within TTL, skip lookup
    //   None            — not cached or expired TTL, caller must fetch
    fn get(&self, key: &str) -> Option<Option<String>> {
        let entry = self.entries.get(key)?;
        if !entry.is_valid() {
            return None;
        }
        Some(entry.url.clone())
    }

    fn insert(&mut self, key: String, url: Option<String>) {
        // Remove existing key from order so we don't leave a dangling entry
        if self.entries.contains_key(&key) {
            self.order.retain(|k| k != &key);
        }
        self.entries.insert(
            key.clone(),
            CacheEntry {
                url,
                fetched_at: unix_now(),
            },
        );
        self.order.push_back(key);

        // FIFO eviction once over the limit
        while self.order.len() > MAX_ENTRIES {
            if let Some(oldest) = self.order.pop_front() {
                self.entries.remove(&oldest);
            }
        }
    }

    fn save(&self) {
        if let Ok(json) = serde_json::to_string(&self.entries) {
            let _ = std::fs::write(&self.cache_file, json);
        }
    }
}

pub struct DiscordArtworkCache(Arc<RwLock<Inner>>);

impl DiscordArtworkCache {
    pub fn load(cache_file: PathBuf) -> Self {
        Self(Arc::new(RwLock::new(Inner::load(cache_file))))
    }

    pub fn get(&self, key: &str) -> Option<Option<String>> {
        self.0.read().unwrap().get(key)
    }

    pub fn insert_and_save(&self, key: String, url: Option<String>) {
        let mut inner = self.0.write().unwrap();
        inner.insert(key, url);
        inner.save();
    }
}

/// Normalised cache key: lowercase, trimmed artist + album separated by "||".
pub fn cache_key(artist: &str, album: &str) -> String {
    format!(
        "{}||{}",
        artist.trim().to_lowercase(),
        album.trim().to_lowercase()
    )
}

#[derive(Deserialize)]
struct ItunesResponse {
    results: Vec<ItunesResult>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ItunesResult {
    #[serde(rename = "artworkUrl100")]
    artwork_url_100: Option<String>,
}

/// Queries the iTunes Search API and returns a 600×600 artwork URL, or None if
/// not found. Network/API errors return None without caching (will retry next time).
pub async fn fetch_itunes_artwork(artist: &str, album: &str) -> Option<String> {
    if artist.is_empty() && album.is_empty() {
        return None;
    }

    let term = format!("{} {}", artist, album);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .ok()?;

    let resp = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", term.as_str()), ("entity", "album"), ("limit", "1")])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let data: ItunesResponse = resp.json().await.ok()?;
    let art_url = data.results.into_iter().next()?.artwork_url_100?;
    Some(art_url.replace("100x100bb", "600x600bb"))
}
