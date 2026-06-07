use crate::models::PlaybackState;
use discord_rich_presence::{
    DiscordIpc, DiscordIpcClient,
    activity::{Activity, Assets, Timestamps},
};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

// Create your Discord application at https://discord.com/developers/applications
// and paste your Application ID here.
pub const CLIENT_ID: &str = "1513249496384016496";

pub struct DiscordRpcState(pub Mutex<Option<DiscordIpcClient>>);

pub fn try_connect() -> Option<DiscordIpcClient> {
    let mut client = DiscordIpcClient::new(CLIENT_ID);
    client.connect().ok()?;
    eprintln!("[Discord RPC] Connected.");
    Some(client)
}

pub fn update_presence(rpc: &DiscordRpcState, state: &PlaybackState) {
    let Ok(mut guard) = rpc.0.lock() else { return };

    // Lazily reconnect if the connection dropped.
    if guard.is_none() {
        *guard = try_connect();
    }

    let Some(client) = guard.as_mut() else { return };

    let Some(track) = &state.current_track else {
        let _ = client.clear_activity();
        return;
    };

    let details = track.title.clone();
    let activity_state = if track.album.is_empty() {
        track.artist.clone()
    } else {
        format!("{} · {}", track.artist, track.album)
    };

    let small_image = if state.is_playing { "playing" } else { "paused" };
    let small_text = if state.is_playing { "Playing" } else { "Paused" };

    let assets = Assets::new()
        .large_image("viby_logo")
        .large_text("Viby")
        .small_image(small_image)
        .small_text(small_text);

    let mut activity = Activity::new()
        .details(&details)
        .state(&activity_state)
        .assets(assets);

    // Elapsed time — only shown while playing so the timer doesn't keep
    // counting while paused.
    if state.is_playing {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let start = now - state.position_secs as i64;
        activity = activity.timestamps(Timestamps::new().start(start));
    }

    if client.set_activity(activity).is_err() {
        eprintln!("[Discord RPC] Lost connection — will retry on next update.");
        *guard = None;
    }
}

pub fn clear_presence(rpc: &DiscordRpcState) {
    let Ok(mut guard) = rpc.0.lock() else { return };
    if let Some(client) = guard.as_mut() {
        let _ = client.clear_activity();
    }
}
