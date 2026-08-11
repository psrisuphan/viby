use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    path::PathBuf,
    sync::{Arc, RwLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_ENTRIES: usize = 1000;
const MAX_CACHE_FILE_BYTES: u64 = 2 * 1024 * 1024;
// Negative hits (confirmed not found) are cached for 30 days so we don't spam
// the iTunes API on every play of a track with no album art on iTunes.
const NOT_FOUND_TTL_SECS: u64 = 30 * 24 * 60 * 60;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ArtworkInfo {
    /// 1024×1024 artwork URL (None when the album has no iTunes artwork).
    pub art_url: Option<String>,
    /// iTunes/Apple Music page for the exact track.
    pub track_url: Option<String>,
    /// iTunes/Apple Music page for the album.
    pub collection_url: Option<String>,
    /// iTunes/Apple Music page for the artist.
    pub artist_url: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct CacheEntry {
    pub info: Option<ArtworkInfo>,
    pub fetched_at: u64,
}

impl CacheEntry {
    fn is_valid(&self) -> bool {
        if self.info.is_some() {
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
        let mut entries = read_cache_file(&cache_file)
            .and_then(|s| serde_json::from_str::<HashMap<String, CacheEntry>>(&s).ok())
            .unwrap_or_default();
        if entries.len() > MAX_ENTRIES {
            entries = entries.into_iter().take(MAX_ENTRIES).collect();
        }
        let order: VecDeque<String> = entries.keys().cloned().collect();
        Self {
            entries,
            order,
            cache_file,
        }
    }

    // Returns:
    //   Some(Some(info)) — positive cache hit, use the info
    //   Some(None)       — negative hit still within TTL, skip lookup
    //   None             — not cached or expired TTL, caller must fetch
    fn get(&self, key: &str) -> Option<Option<ArtworkInfo>> {
        let entry = self.entries.get(key)?;
        if !entry.is_valid() {
            return None;
        }
        Some(entry.info.clone())
    }

    fn insert(&mut self, key: String, info: Option<ArtworkInfo>) {
        // Remove existing key from order so we don't leave a dangling entry
        if self.entries.contains_key(&key) {
            self.order.retain(|k| k != &key);
        }
        self.entries.insert(
            key.clone(),
            CacheEntry {
                info,
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

fn read_cache_file(path: &std::path::Path) -> Option<String> {
    use std::io::Read;

    let file = std::fs::File::open(path).ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut bytes = Vec::new();
    file.take(MAX_CACHE_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_CACHE_FILE_BYTES {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub struct DiscordArtworkCache(Arc<RwLock<Inner>>);

impl DiscordArtworkCache {
    pub fn load(cache_file: PathBuf) -> Self {
        Self(Arc::new(RwLock::new(Inner::load(cache_file))))
    }

    pub fn get(&self, key: &str) -> Option<Option<ArtworkInfo>> {
        self.0
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(key)
    }

    pub fn insert_and_save(&self, key: String, info: Option<ArtworkInfo>) {
        let mut inner = self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.insert(key, info);
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

#[cfg(test)]
mod tests {
    use super::{ArtworkInfo, Inner, MAX_CACHE_FILE_BYTES};

    #[test]
    fn oversized_cache_files_are_ignored() {
        let path =
            std::env::temp_dir().join(format!("viby-art-cache-{}.json", uuid::Uuid::new_v4()));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_CACHE_FILE_BYTES + 1).unwrap();
        assert!(Inner::load(path.clone()).entries.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn cache_roundtrips_artwork_info() {
        let path =
            std::env::temp_dir().join(format!("viby-art-cache-{}.json", uuid::Uuid::new_v4()));
        let mut inner = Inner::load(path.clone());
        let info = ArtworkInfo {
            art_url: Some("https://example.com/art.jpg".into()),
            track_url: Some("https://example.com/track".into()),
            collection_url: Some("https://example.com/album".into()),
            artist_url: None,
        };
        inner.insert("artist||album".into(), Some(info.clone()));
        assert_eq!(inner.get("artist||album"), Some(Some(info)));
        // Negative hits are cached as None until the TTL expires.
        inner.insert("nope||nope".into(), None);
        assert_eq!(inner.get("nope||nope"), Some(None));
        let _ = std::fs::remove_file(path);
    }
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
    #[serde(rename = "trackViewUrl")]
    track_view_url: Option<String>,
    #[serde(rename = "collectionViewUrl")]
    collection_view_url: Option<String>,
    #[serde(rename = "artistViewUrl")]
    artist_view_url: Option<String>,
}

/// Queries the iTunes Search API for the album of the given artist and returns
/// the artwork URL plus Apple Music page links, or None if not found.
/// Network/API errors return None without caching (will retry next time).
pub async fn fetch_itunes_info(artist: &str, album: &str) -> Option<ArtworkInfo> {
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
        .query(&[("term", term.as_str()), ("entity", "song"), ("limit", "1")])
        .send()
        .await
        .ok()?;

    if !resp.status().is_success() {
        return None;
    }

    let data: ItunesResponse = resp.json().await.ok()?;
    let result = data.results.into_iter().next()?;
    Some(ArtworkInfo {
        art_url: result
            .artwork_url_100
            .map(|url| url.replace("100x100bb", "1024x1024bb")),
        track_url: result.track_view_url,
        collection_url: result.collection_view_url,
        artist_url: result.artist_view_url,
    })
}
