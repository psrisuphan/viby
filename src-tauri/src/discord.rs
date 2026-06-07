use crate::models::PlaybackState;
use discord_rich_presence::{
    DiscordIpc, DiscordIpcClient,
    activity::{Activity, ActivityType, Assets, StatusDisplayType, Timestamps},
};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const CLIENT_ID: &str = "1513249496384016496";

pub struct DiscordRpcState(pub Mutex<Option<DiscordIpcClient>>);

pub fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(CLIENT_ID);
    client.connect().ok()?;
    eprintln!("[Discord RPC] Connected.");
    Some(client)
}

// Builds and sends the activity for the given state. Returns true on success.
fn send_activity(client: &mut DiscordIpcClient, state: &PlaybackState, artwork_url: Option<&str>) -> bool {
    let Some(track) = &state.current_track else {
        return client.clear_activity().is_ok();
    };

    let details = track.title.clone();
    let activity_state = if track.album.is_empty() {
        track.artist.clone()
    } else {
        format!("{} · {}", track.artist, track.album)
    };

    let small_image = if state.is_playing { "playing" } else { "paused" };
    let small_text = if state.is_playing { "Playing" } else { "Paused" };

    let large_image = artwork_url.unwrap_or("viby_logo");
    let large_text = if artwork_url.is_some() {
        format!("{} — {}", track.artist, track.album)
    } else {
        "Viby".to_string()
    };

    let assets = Assets::new()
        .large_image(large_image)
        .large_text(&large_text)
        .small_image(small_image)
        .small_text(small_text);

    // Listening type auto-starts an elapsed timer even without explicit timestamps.
    // Use it only while playing (with progress bar); fall back to Playing when paused
    // so Discord shows no timer at all.
    let mut activity = Activity::new()
        .status_display_type(StatusDisplayType::Details)
        .details(&details)
        .state(&activity_state)
        .assets(assets);

    if state.is_playing {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let start = now - state.position_secs as i64;
        let end = start + state.duration_secs as i64;
        activity = activity
            .activity_type(ActivityType::Listening)
            .timestamps(Timestamps::new().start(start).end(end));
    } else {
        activity = activity.activity_type(ActivityType::Playing);
    }

    client.set_activity(activity).is_ok()
}

pub fn update_presence(rpc: &DiscordRpcState, state: &PlaybackState, artwork_url: Option<&str>) {
    let Ok(mut guard) = rpc.0.lock() else { return };

    if guard.is_none() {
        *guard = try_connect();
    }

    let succeeded = if let Some(client) = guard.as_mut() {
        send_activity(client, state, artwork_url)
    } else {
        return;
    };

    if !succeeded {
        // IPC socket dropped — reconnect immediately and retry so the paused/playing
        // state always reaches Discord rather than leaving a stale timer running.
        eprintln!("[Discord RPC] Lost connection — reconnecting...");
        *guard = None;
        *guard = try_connect();
        if let Some(client) = guard.as_mut() {
            send_activity(client, state, artwork_url);
        }
    }
}

pub fn clear_presence(rpc: &DiscordRpcState) {
    let Ok(mut guard) = rpc.0.lock() else { return };
    if let Some(client) = guard.as_mut() {
        let _ = client.clear_activity();
    }
}
