use crate::artwork_cache::ArtworkInfo;
use crate::models::PlaybackState;
use discord_rich_presence::{
    DiscordIpc, DiscordIpcClient,
    activity::{Activity, ActivityType, Assets, StatusDisplayType, Timestamps},
};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const CLIENT_ID: &str = "1513249496384016496";
// Discord permits at most 5 activity updates per 20 seconds.
const MIN_ACTIVITY_UPDATE_INTERVAL: Duration = Duration::from_secs(4);
const CONNECT_RETRY_INTERVAL: Duration = Duration::from_secs(15);

#[derive(Clone)]
struct PendingPresence {
    state: PlaybackState,
    artwork: Option<ArtworkInfo>,
}

pub struct DiscordRpcInner {
    pub client: Option<DiscordIpcClient>,
    pub last_connect_attempt: Option<Instant>,
    pub last_track_id: Option<String>,
    pub last_is_playing: bool,
    pub last_position_baseline: Option<i64>,
    pub last_artwork_url: Option<String>,
    pub last_show_quality: bool,
    pub last_activity_update: Option<Instant>,
    pending: Option<PendingPresence>,
}

impl DiscordRpcInner {
    pub fn new() -> Self {
        Self {
            client: None,
            last_connect_attempt: None,
            last_track_id: None,
            last_is_playing: false,
            last_position_baseline: None,
            last_artwork_url: None,
            last_show_quality: false,
            last_activity_update: None,
            pending: None,
        }
    }
}

pub struct DiscordRpcState(pub Mutex<DiscordRpcInner>);

pub fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(CLIENT_ID);
    client.connect().ok()?;
    eprintln!("[Discord RPC] Connected.");
    Some(client)
}

fn get_quality_desc(state: &PlaybackState) -> Option<String> {
    let sample_rate = state.sample_rate?;
    
    // Resolution alone cannot establish that a file is lossless. It can only
    // identify high-resolution PCM properties.
    let is_hi_res = sample_rate > 48000 || state.bits_per_sample.is_some_and(|b| b > 16);

    let khz = (sample_rate as f64) / 1000.0;
    let khz_str = if sample_rate % 1000 == 0 {
        format!("{:.0}", khz)
    } else {
        format!("{:.1}", khz)
    };

    let bit_depth = state.bits_per_sample.map(|bits| format!("{}-bit", bits));
    
    let mut parts = Vec::new();
    if is_hi_res {
        parts.push("Hi-Res".to_string());
    }
    if let Some(bd) = bit_depth {
        parts.push(bd);
    }
    parts.push(format!("{} kHz", khz_str));

    Some(parts.join(" • "))
}

fn artwork_url(artwork: Option<&ArtworkInfo>) -> Option<&str> {
    artwork.and_then(|info| info.art_url.as_deref())
}

fn activity_update_due(last_update: Option<Instant>, now: Instant) -> bool {
    last_update.is_none_or(|last| now.duration_since(last) >= MIN_ACTIVITY_UPDATE_INTERVAL)
}

fn activity_update_delay(last_update: Option<Instant>, now: Instant) -> Duration {
    last_update
        .map(|last| MIN_ACTIVITY_UPDATE_INTERVAL.saturating_sub(now.duration_since(last)))
        .unwrap_or_default()
}

fn connection_retry_delay(last_attempt: Option<Instant>, now: Instant) -> Duration {
    last_attempt
        .map(|last| CONNECT_RETRY_INTERVAL.saturating_sub(now.duration_since(last)))
        .filter(|delay| !delay.is_zero())
        .unwrap_or(CONNECT_RETRY_INTERVAL)
}

fn build_activity<'a>(
    state: &'a PlaybackState,
    artwork: Option<&'a ArtworkInfo>,
    show_quality: bool,
) -> Option<Activity<'a>> {
    if !state.is_playing && state.duration_secs > 0.0 && state.position_secs >= state.duration_secs
    {
        return None;
    }

    let Some(track) = &state.current_track else {
        return None;
    };

    // Line 1: track title
    // Line 2: artist name only
    // Image tooltip: album name (avoids duplicating artist+album on both lines)
    let small_image = if state.is_playing {
        "playing"
    } else {
        "paused"
    };
    let small_text = if state.is_playing {
        "Playing"
    } else {
        "Paused"
    };

    let large_image = artwork
        .and_then(|a| a.art_url.as_deref())
        .unwrap_or("viby_logo");
    let large_text = if !track.album.is_empty() {
        track.album.clone()
    } else {
        "Viby".to_string()
    };

    let mut assets = Assets::new()
        .large_image(large_image)
        .large_text(large_text)
        .small_image(small_image)
        .small_text(small_text);
    if let Some(url) = artwork.and_then(|a| a.collection_url.as_deref()) {
        assets = assets.large_url(url);
    }

    let state_text = if show_quality {
        get_quality_desc(state)
            .map(|quality| format!("{} • {}", track.artist, quality))
            .unwrap_or_else(|| track.artist.clone())
    } else {
        track.artist.clone()
    };

    let mut activity = Activity::new()
        .status_display_type(StatusDisplayType::Details)
        .details(track.title.clone())
        .state(state_text)
        .assets(assets);
    // Clickable links: track title -> song page, artist line -> artist page.
    if let Some(url) = artwork.and_then(|a| a.track_url.as_deref()) {
        activity = activity.details_url(url);
    }
    if let Some(url) = artwork.and_then(|a| a.artist_url.as_deref()) {
        activity = activity.state_url(url);
    }

    if state.is_playing {
        activity = activity.activity_type(ActivityType::Listening);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let start = now - state.position_secs as i64;
        let end = start + state.duration_secs as i64;
        activity = activity.timestamps(Timestamps::new().start(start).end(end));
    } else {
        // Use Listening activity type when paused as well. Since timestamps are omitted,
        // Discord will not show an elapsed timer. Using Playing (Game) type causes Discord
        // to automatically display a session timer.
        activity = activity.activity_type(ActivityType::Listening);
    }

    Some(activity)
}

// Builds and sends the activity for the given state. Returns true on success.
fn send_activity(
    client: &mut DiscordIpcClient,
    state: &PlaybackState,
    artwork: Option<&ArtworkInfo>,
    show_quality: bool,
) -> bool {
    if !state.is_playing {
        return client.clear_activity().is_ok();
    }

    let Some(activity) = build_activity(state, artwork, show_quality) else {
        return client.clear_activity().is_ok();
    };

    client.set_activity(activity).is_ok()
}

fn send_presence(
    guard: &mut DiscordRpcInner,
    state: &PlaybackState,
    artwork: Option<&ArtworkInfo>,
    show_quality: bool,
    now: Instant,
) -> Result<(), Duration> {
    if guard.client.is_none() {
        if let Some(last_attempt) = guard.last_connect_attempt
            && now.duration_since(last_attempt) < CONNECT_RETRY_INTERVAL
        {
            return Err(connection_retry_delay(Some(last_attempt), now));
        }
        guard.last_connect_attempt = Some(now);
        guard.client = try_connect();
    }

    let mut sent = guard
        .client
        .as_mut()
        .is_some_and(|client| send_activity(client, state, artwork, show_quality));
    if !sent {
        eprintln!("[Discord RPC] Lost connection — reconnecting...");
        guard.client = None;
        guard.last_connect_attempt = Some(now);
        guard.client = try_connect();
        sent = guard
            .client
            .as_mut()
            .is_some_and(|client| send_activity(client, state, artwork, show_quality));
    }

    sent.then_some(()).ok_or(CONNECT_RETRY_INTERVAL)
}

fn record_activity(
    guard: &mut DiscordRpcInner,
    state: &PlaybackState,
    artwork: Option<&ArtworkInfo>,
    show_quality: bool,
    now: Instant,
) {
    let track_id = state.current_track.as_ref().map(|t| t.id.clone());
    let is_playing = state.is_playing;
    let current_artwork_url = artwork_url(artwork).map(str::to_owned);
    let unix_now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    guard.last_track_id = track_id;
    guard.last_is_playing = is_playing;
    guard.last_position_baseline = is_playing.then_some(unix_now - state.position_secs as i64);
    guard.last_artwork_url = current_artwork_url;
    guard.last_show_quality = show_quality;
    guard.last_activity_update = Some(now);
}

fn should_update(
    guard: &DiscordRpcInner,
    state: &PlaybackState,
    artwork: Option<&ArtworkInfo>,
    show_quality: bool,
) -> bool {
    let track_id = state.current_track.as_ref().map(|t| t.id.clone());
    let is_playing = state.is_playing;
    let current_artwork_url = artwork_url(artwork).map(str::to_owned);
    let unix_now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let current_baseline = is_playing.then_some(unix_now - state.position_secs as i64);

    current_artwork_url != guard.last_artwork_url
        || track_id != guard.last_track_id
        || is_playing != guard.last_is_playing
        || show_quality != guard.last_show_quality
        || match (current_baseline, guard.last_position_baseline) {
            (Some(cur), Some(last)) => (cur - last).abs() > 1,
            (Some(_), None) | (None, Some(_)) => true,
            (None, None) => false,
        }
}

/// Sends now or queues the latest state for Discord's next permitted update.
/// Returns the delay a caller should schedule for `flush_pending_presence`.
pub fn update_presence(
    rpc: &DiscordRpcState,
    enabled: &AtomicBool,
    quality: &AtomicBool,
    state: &PlaybackState,
    artwork: Option<&ArtworkInfo>,
) -> Option<Duration> {
    let Ok(mut guard) = rpc.0.lock() else { return None };
    if !enabled.load(Ordering::SeqCst) {
        return None;
    }
    let show_quality = quality.load(Ordering::SeqCst);
    if !should_update(&guard, state, artwork, show_quality) && guard.client.is_some() {
        return None;
    }

    let now = Instant::now();
    if guard.client.is_some() && !activity_update_due(guard.last_activity_update, now) {
        guard.pending = Some(PendingPresence {
            state: state.clone(),
            artwork: artwork.cloned(),
        });
        return Some(activity_update_delay(guard.last_activity_update, now));
    }

    match send_presence(&mut guard, state, artwork, show_quality, now) {
        Ok(()) => {
            record_activity(&mut guard, state, artwork, show_quality, now);
            guard.pending = None;
            None
        }
        Err(delay) => {
            guard.pending = Some(PendingPresence {
                state: state.clone(),
                artwork: artwork.cloned(),
            });
            Some(delay)
        }
    }
}

/// Flushes the newest rate-limited presence update, if any.
pub fn flush_pending_presence(
    rpc: &DiscordRpcState,
    enabled: &AtomicBool,
    quality: &AtomicBool,
) -> Option<Duration> {
    let Ok(mut guard) = rpc.0.lock() else { return None };
    if !enabled.load(Ordering::SeqCst) {
        guard.pending = None;
        return None;
    }

    let Some(pending) = guard.pending.clone() else {
        return None;
    };
    let now = Instant::now();
    if !activity_update_due(guard.last_activity_update, now) {
        return Some(activity_update_delay(guard.last_activity_update, now));
    }

    let show_quality = quality.load(Ordering::SeqCst);
    match send_presence(
        &mut guard,
        &pending.state,
        pending.artwork.as_ref(),
        show_quality,
        now,
    ) {
        Ok(()) => {
            record_activity(
                &mut guard,
                &pending.state,
                pending.artwork.as_ref(),
                show_quality,
                now,
            );
            guard.pending = None;
            None
        }
        Err(delay) => Some(delay),
    }
}

pub fn clear_presence(rpc: &DiscordRpcState) {
    let Ok(mut guard) = rpc.0.lock() else { return };
    if let Some(client) = guard.client.as_mut() {
        let _ = client.clear_activity();
    }
    guard.last_track_id = None;
    guard.last_is_playing = false;
    guard.last_position_baseline = None;
    guard.last_artwork_url = None;
    guard.last_show_quality = false;
    guard.last_activity_update = None;
    guard.pending = None;
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AudioPathStatus, Track};

    fn playback_state(is_playing: bool) -> PlaybackState {
        PlaybackState {
            is_playing,
            current_track: Some(Track {
                id: "track-1".to_string(),
                title: "Test Title".to_string(),
                artist: "Test Artist".to_string(),
                album: "Test Album".to_string(),
                album_artist: "Test Album Artist".to_string(),
                genre: "Test Genre".to_string(),
                year: Some(2026),
                track_number: Some(1),
                disc_number: Some(1),
                duration_secs: 240.0,
                file_path: "/tmp/test.flac".to_string(),
                file_size: 1024,
                replaygain_track_gain: None,
                replaygain_track_peak: None,
                normalization_source: None,
                file_modified_unix: None,
                date_added: "2026-06-10T00:00:00Z".to_string(),
            }),
            position_secs: 42.0,
            duration_secs: 240.0,
            volume: 1.0,
            shuffle: false,
            repeat_mode: "off".to_string(),
            sample_rate: Some(44_100),
            channels: Some(2),
            bits_per_sample: Some(16),
            audio_path: AudioPathStatus::idle(),
        }
    }

    #[test]
    fn paused_activity_uses_listening_without_timestamps() {
        let state = playback_state(false);
        let activity = build_activity(&state, None, false).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["type"], 2);
        assert!(value.get("timestamps").is_none());
        assert_eq!(value["assets"]["small_image"], "paused");
        assert_eq!(value["assets"]["small_text"], "Paused");
    }

    #[test]
    fn playing_activity_uses_listening_with_timestamps() {
        let state = playback_state(true);
        let activity = build_activity(&state, None, false).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["type"], 2);
        assert!(value["timestamps"]["start"].is_i64());
        assert!(value["timestamps"]["end"].is_i64());
        assert_eq!(value["assets"]["small_image"], "playing");
        assert_eq!(value["assets"]["small_text"], "Playing");
    }

    #[test]
    fn activity_includes_playback_quality_when_enabled() {
        let state = playback_state(true);
        let activity = build_activity(&state, None, true).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(
            value["state"],
            "Test Artist • 16-bit • 44.1 kHz"
        );
    }

    #[test]
    fn activity_omits_playback_quality_when_disabled() {
        let state = playback_state(true);
        let activity = build_activity(&state, None, false).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["state"], "Test Artist");
    }

    #[test]
    fn activity_links_track_artist_and_album_pages() {
        let state = playback_state(true);
        let info = ArtworkInfo {
            art_url: Some("https://example.com/art.jpg".into()),
            track_url: Some("https://music.apple.com/track".into()),
            collection_url: Some("https://music.apple.com/album".into()),
            artist_url: Some("https://music.apple.com/artist".into()),
        };
        let activity = build_activity(&state, Some(&info), false).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["details_url"], "https://music.apple.com/track");
        assert_eq!(value["state_url"], "https://music.apple.com/artist");
        assert_eq!(value["assets"]["large_image"], "https://example.com/art.jpg");
        assert_eq!(value["assets"]["large_url"], "https://music.apple.com/album");
    }

    #[test]
    fn activity_falls_back_to_logo_without_artwork() {
        let state = playback_state(true);
        let activity = build_activity(&state, None, false).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["assets"]["large_image"], "viby_logo");
        assert!(value.get("details_url").is_none());
        assert!(value.get("state_url").is_none());
        assert!(value["assets"].get("large_url").is_none());
    }

    #[test]
    fn finished_track_clears_activity() {
        let mut state = playback_state(false);
        state.position_secs = state.duration_secs;

        assert!(build_activity(&state, None, false).is_none());
    }

    #[test]
    fn disabled_rpc_ignores_queued_updates() {
        let rpc = DiscordRpcState(Mutex::new(DiscordRpcInner::new()));
        let enabled = AtomicBool::new(false);
        let quality = AtomicBool::new(true);

        update_presence(&rpc, &enabled, &quality, &playback_state(true), None);

        let guard = rpc.0.lock().expect("rpc lock");
        assert!(guard.client.is_none());
        assert!(guard.last_track_id.is_none());
    }

    #[test]
    fn activity_updates_are_limited_to_discords_rate() {
        let now = Instant::now();

        assert!(activity_update_due(None, now));
        assert!(!activity_update_due(Some(now), now + Duration::from_secs(3)));
        assert!(activity_update_due(Some(now), now + MIN_ACTIVITY_UPDATE_INTERVAL));
    }

    #[test]
    fn artwork_arrival_is_detected_as_a_presence_change() {
        let info = ArtworkInfo {
            art_url: Some("https://example.com/art.jpg".to_string()),
            track_url: None,
            collection_url: None,
            artist_url: None,
        };
        let cached_artwork_url = artwork_url(Some(&info)).map(str::to_owned);
        let last_artwork_url: Option<String> = None;

        assert_ne!(cached_artwork_url, last_artwork_url);
        assert_eq!(artwork_url(None), None);
    }
}
