use crate::models::PlaybackState;
use discord_rich_presence::{
    DiscordIpc, DiscordIpcClient,
    activity::{Activity, ActivityType, Assets, StatusDisplayType, Timestamps},
};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const CLIENT_ID: &str = "1513249496384016496";

use std::time::Instant;

pub struct DiscordRpcInner {
    pub client: Option<DiscordIpcClient>,
    pub last_connect_attempt: Option<Instant>,
    pub last_track_id: Option<String>,
    pub last_is_playing: bool,
    pub last_position_baseline: Option<i64>,
}

pub struct DiscordRpcState(pub Mutex<DiscordRpcInner>);

pub fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(CLIENT_ID);
    client.connect().ok()?;
    eprintln!("[Discord RPC] Connected.");
    Some(client)
}

fn build_activity<'a>(
    state: &'a PlaybackState,
    artwork_url: Option<&'a str>,
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

    let large_image = artwork_url.unwrap_or("viby_logo");
    let large_text = if !track.album.is_empty() {
        track.album.clone()
    } else {
        "Viby".to_string()
    };

    let assets = Assets::new()
        .large_image(large_image)
        .large_text(large_text)
        .small_image(small_image)
        .small_text(small_text);

    let mut activity = Activity::new()
        .status_display_type(StatusDisplayType::Details)
        .details(track.title.clone())
        .state(track.artist.clone())
        .assets(assets);

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
        // Listening auto-starts an elapsed timer in Discord even without explicit
        // timestamps. Use Playing while paused so Discord drops the progress timer.
        activity = activity.activity_type(ActivityType::Playing);
    }

    Some(activity)
}

// Builds and sends the activity for the given state. Returns true on success.
fn send_activity(
    client: &mut DiscordIpcClient,
    state: &PlaybackState,
    artwork_url: Option<&str>,
) -> bool {
    let Some(activity) = build_activity(state, artwork_url) else {
        return client.clear_activity().is_ok();
    };

    client.set_activity(activity).is_ok()
}

pub fn update_presence(rpc: &DiscordRpcState, state: &PlaybackState, artwork_url: Option<&str>) {
    let Ok(mut guard) = rpc.0.lock() else { return };

    let track_id = state.current_track.as_ref().map(|t| t.id.clone());
    let is_playing = state.is_playing;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let current_baseline = if is_playing {
        Some(now - state.position_secs as i64)
    } else {
        None
    };

    // Check if we actually need to send an update to Discord to avoid hitting rate limits.
    let should_update = track_id != guard.last_track_id
        || is_playing != guard.last_is_playing
        || match (current_baseline, guard.last_position_baseline) {
            (Some(cur), Some(last)) => (cur - last).abs() > 1,
            (Some(_), None) | (None, Some(_)) => true,
            (None, None) => false,
        };

    if !should_update && guard.client.is_some() {
        return;
    }

    // Attempt to connect if not connected, respecting cooldown
    if guard.client.is_none() {
        let now_inst = Instant::now();
        if let Some(last) = guard.last_connect_attempt {
            if now_inst.duration_since(last) < std::time::Duration::from_secs(15) {
                return;
            }
        }
        guard.last_connect_attempt = Some(now_inst);
        guard.client = try_connect();
    }

    let succeeded = if let Some(client) = guard.client.as_mut() {
        send_activity(client, state, artwork_url)
    } else {
        return;
    };

    if !succeeded {
        eprintln!("[Discord RPC] Lost connection — reconnecting...");
        guard.client = None;
        let now_inst = Instant::now();
        guard.last_connect_attempt = Some(now_inst);
        guard.client = try_connect();
        if let Some(client) = guard.client.as_mut() {
            send_activity(client, state, artwork_url);
        }
    }

    // Cache the updated state
    guard.last_track_id = track_id;
    guard.last_is_playing = is_playing;
    guard.last_position_baseline = current_baseline;
}

pub fn clear_presence(rpc: &DiscordRpcState) {
    let Ok(mut guard) = rpc.0.lock() else { return };
    if let Some(client) = guard.client.as_mut() {
        let _ = client.clear_activity();
    }
    guard.last_track_id = None;
    guard.last_is_playing = false;
    guard.last_position_baseline = None;
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
    fn paused_activity_uses_playing_without_timestamps() {
        let state = playback_state(false);
        let activity = build_activity(&state, None).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["type"], 0);
        assert!(value.get("timestamps").is_none());
        assert_eq!(value["assets"]["small_image"], "paused");
        assert_eq!(value["assets"]["small_text"], "Paused");
    }

    #[test]
    fn playing_activity_uses_listening_with_timestamps() {
        let state = playback_state(true);
        let activity = build_activity(&state, None).expect("activity");
        let value = serde_json::to_value(activity).expect("activity json");

        assert_eq!(value["type"], 2);
        assert!(value["timestamps"]["start"].is_i64());
        assert!(value["timestamps"]["end"].is_i64());
        assert_eq!(value["assets"]["small_image"], "playing");
        assert_eq!(value["assets"]["small_text"], "Playing");
    }

    #[test]
    fn finished_track_clears_activity() {
        let mut state = playback_state(false);
        state.position_secs = state.duration_secs;

        assert!(build_activity(&state, None).is_none());
    }
}
