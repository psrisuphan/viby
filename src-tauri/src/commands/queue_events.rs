use tauri::{AppHandle, Emitter};

use crate::audio::queue::PlaybackQueue;
use crate::commands::playback::playback_debug_enabled;
use crate::models::{QueuePayload, QueuePositionPayload};

pub(crate) fn emit_queue_changed(app: &AppHandle, queue: &PlaybackQueue) {
    let payload = QueuePayload {
        tracks: queue.get_play_order_tracks(),
        current_index: queue.get_current_index(),
    };
    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] queue-changed tracks={} current_index={:?}",
            payload.tracks.len(),
            payload.current_index
        );
    }
    if let Err(error) = app.emit("queue-changed", &payload) {
        eprintln!("[PlaybackCommand] Failed to emit queue-changed: {error}");
    }
}

pub(crate) fn emit_queue_position_changed(app: &AppHandle, queue: &PlaybackQueue) {
    let payload = QueuePositionPayload {
        current_index: queue.get_current_index(),
    };
    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] queue-position-changed current_index={:?} queue_len={}",
            payload.current_index,
            queue.len()
        );
    }
    if let Err(error) = app.emit("queue-position-changed", &payload) {
        eprintln!("[PlaybackCommand] Failed to emit queue-position-changed: {error}");
    }
}
