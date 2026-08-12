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
const TRANSIENT_FAILURE_TTL_SECS: u64 = 60;
// Bump this when negative entries need one-time invalidation. Positive hits
// remain valid indefinitely.
const NEGATIVE_CACHE_VERSION: u8 = 1;

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
    #[serde(default)]
    pub negative_cache_version: u8,
    #[serde(default)]
    pub transient_failure: bool,
}

impl CacheEntry {
    fn is_valid(&self) -> bool {
        if self.info.is_some() {
            return true; // Positive hits never expire
        }
        let now = unix_now();
        let ttl = if self.transient_failure {
            TRANSIENT_FAILURE_TTL_SECS
        } else {
            NOT_FOUND_TTL_SECS
        };
        now.saturating_sub(self.fetched_at) < ttl
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
        // Retry negatives written before failures were distinguished from
        // confirmed empty results. Keep positive artwork hits intact.
        let has_stale_negatives = entries.values().any(|entry| {
            entry.info.is_none() && entry.negative_cache_version != NEGATIVE_CACHE_VERSION
        });
        entries.retain(|_, entry| {
            entry.info.is_some() || entry.negative_cache_version == NEGATIVE_CACHE_VERSION
        });
        if entries.len() > MAX_ENTRIES {
            entries = entries.into_iter().take(MAX_ENTRIES).collect();
        }
        let order: VecDeque<String> = entries.keys().cloned().collect();
        let inner = Self {
            entries,
            order,
            cache_file,
        };
        if has_stale_negatives {
            inner.save();
        }
        inner
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
        self.insert_entry(
            key,
            CacheEntry {
                info,
                fetched_at: unix_now(),
                negative_cache_version: NEGATIVE_CACHE_VERSION,
                transient_failure: false,
            },
        );
    }

    fn insert_failure(&mut self, key: String) {
        self.insert_entry(
            key,
            CacheEntry {
                info: None,
                fetched_at: unix_now(),
                negative_cache_version: NEGATIVE_CACHE_VERSION,
                transient_failure: true,
            },
        );
    }

    fn insert_entry(&mut self, key: String, entry: CacheEntry) {
        // Remove existing key from order so we don't leave a dangling entry
        if self.entries.contains_key(&key) {
            self.order.retain(|k| k != &key);
        }
        self.entries.insert(key.clone(), entry);
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

    pub fn record_failure(&self, key: String) {
        let mut inner = self
            .0
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        inner.insert_failure(key);
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
    use super::{ArtworkInfo, CacheEntry, Inner, MAX_CACHE_FILE_BYTES, NEGATIVE_CACHE_VERSION};
    use std::collections::HashMap;

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

    #[test]
    fn transient_failures_expire_before_confirmed_misses() {
        let now = super::unix_now();
        let transient = CacheEntry {
            info: None,
            fetched_at: now.saturating_sub(super::TRANSIENT_FAILURE_TTL_SECS),
            negative_cache_version: NEGATIVE_CACHE_VERSION,
            transient_failure: true,
        };
        let not_found = CacheEntry {
            info: None,
            fetched_at: now.saturating_sub(super::TRANSIENT_FAILURE_TTL_SECS),
            negative_cache_version: NEGATIVE_CACHE_VERSION,
            transient_failure: false,
        };

        assert!(!transient.is_valid());
        assert!(not_found.is_valid());
    }

    #[test]
    fn load_discards_old_negative_entries_but_keeps_positive_hits() {
        let path =
            std::env::temp_dir().join(format!("viby-art-cache-{}.json", uuid::Uuid::new_v4()));
        let info = ArtworkInfo {
            art_url: Some("https://example.com/art.jpg".into()),
            track_url: None,
            collection_url: None,
            artist_url: None,
        };
        let entries: HashMap<String, CacheEntry> = HashMap::from([
            (
                "old-negative".into(),
                CacheEntry {
                    info: None,
                    fetched_at: super::unix_now(),
                    negative_cache_version: 0,
                    transient_failure: false,
                },
            ),
            (
                "current-negative".into(),
                CacheEntry {
                    info: None,
                    fetched_at: super::unix_now(),
                    negative_cache_version: NEGATIVE_CACHE_VERSION,
                    transient_failure: false,
                },
            ),
            (
                "positive".into(),
                CacheEntry {
                    info: Some(info),
                    fetched_at: super::unix_now(),
                    negative_cache_version: 0,
                    transient_failure: false,
                },
            ),
        ]);
        std::fs::write(&path, serde_json::to_string(&entries).unwrap()).unwrap();

        let inner = Inner::load(path.clone());
        assert!(inner.get("old-negative").is_none());
        assert_eq!(inner.get("current-negative"), Some(None));
        assert!(inner.get("positive").unwrap().is_some());
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

fn normalize_artwork_url(url: Option<String>) -> Option<String> {
    url.map(|url| url.replace("100x100bb", "1024x1024bb"))
}

fn merge_itunes_results(
    song: Option<ItunesResult>,
    album: Option<ItunesResult>,
) -> Option<ArtworkInfo> {
    let art_url = song
        .as_ref()
        .and_then(|result| result.artwork_url_100.clone())
        .or_else(|| {
            album
                .as_ref()
                .and_then(|result| result.artwork_url_100.clone())
        });
    let track_url = song
        .as_ref()
        .and_then(|result| result.track_view_url.clone())
        .or_else(|| {
            album
                .as_ref()
                .and_then(|result| result.track_view_url.clone())
        });
    let collection_url = song
        .as_ref()
        .and_then(|result| result.collection_view_url.clone())
        .or_else(|| {
            album
                .as_ref()
                .and_then(|result| result.collection_view_url.clone())
        });
    let artist_url = song
        .as_ref()
        .and_then(|result| result.artist_view_url.clone())
        .or_else(|| {
            album
                .as_ref()
                .and_then(|result| result.artist_view_url.clone())
        });

    let info = ArtworkInfo {
        art_url: normalize_artwork_url(art_url),
        track_url,
        collection_url,
        artist_url,
    };
    info.art_url.is_some().then_some(info)
}

async fn search_itunes(
    client: &reqwest::Client,
    term: &str,
    entity: &str,
) -> Result<Option<ItunesResult>, ()> {
    let resp = client
        .get("https://itunes.apple.com/search")
        .query(&[("term", term), ("entity", entity), ("limit", "1")])
        .send()
        .await
        .map_err(|_| ())?;

    if !resp.status().is_success() {
        return Err(());
    }

    Ok(resp
        .json::<ItunesResponse>()
        .await
        .map_err(|_| ())?
        .results
        .into_iter()
        .next())
}

/// Queries the iTunes Search API for the track, then the album if needed.
/// `Ok(None)` is a confirmed no-artwork result; `Err(())` is transient and
/// must not be persisted as a negative cache hit.
pub async fn fetch_itunes_info(artist: &str, album: &str) -> Result<Option<ArtworkInfo>, ()> {
    if artist.is_empty() && album.is_empty() {
        return Ok(None);
    }

    let term = format!("{} {}", artist.trim(), album.trim());
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|_| ())?;

    let song = search_itunes(&client, &term, "song").await?;
    let song_has_artwork = song
        .as_ref()
        .and_then(|result| result.artwork_url_100.as_ref())
        .is_some();
    let album_result = if song_has_artwork || album.trim().is_empty() {
        None
    } else {
        search_itunes(&client, &term, "album").await?
    };

    Ok(merge_itunes_results(song, album_result))
}

#[cfg(test)]
mod itunes_tests {
    use super::{ItunesResult, merge_itunes_results};

    fn result(artwork_url_100: Option<&str>) -> ItunesResult {
        ItunesResult {
            artwork_url_100: artwork_url_100.map(str::to_string),
            track_view_url: Some("https://music.apple.com/track".to_string()),
            collection_view_url: Some("https://music.apple.com/album".to_string()),
            artist_view_url: Some("https://music.apple.com/artist".to_string()),
        }
    }

    #[test]
    fn album_result_supplies_artwork_when_song_result_has_none() {
        let info = merge_itunes_results(
            Some(result(None)),
            Some(result(Some("https://example.com/100x100bb.jpg"))),
        )
        .expect("merged artwork info");

        assert_eq!(
            info.art_url.as_deref(),
            Some("https://example.com/1024x1024bb.jpg")
        );
        assert_eq!(
            info.track_url.as_deref(),
            Some("https://music.apple.com/track")
        );
    }

    #[test]
    fn empty_results_use_the_viby_logo_fallback() {
        assert!(merge_itunes_results(None, None).is_none());
    }
}
