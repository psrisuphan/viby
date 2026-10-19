use tauri::AppHandle;
use tauri_specta::Event as _;

use crate::audio::queue::PlaybackQueue;
use crate::commands::playback::playback_debug_enabled;
use crate::models::{QueueChanged, QueuePayload, QueuePositionChanged, QueuePositionPayload};

pub(crate) fn queue_changed_payload(queue: &PlaybackQueue) -> QueuePayload {
    QueuePayload {
        tracks: queue.get_play_order_tracks(),
        current_index: queue.get_current_index(),
    }
}

pub(crate) fn emit_queue_payload_changed(app: &AppHandle, payload: &QueuePayload) {
    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] queue-changed tracks={} current_index={:?}",
            payload.tracks.len(),
            payload.current_index
        );
    }
    if let Err(error) = QueueChanged(payload.clone()).emit(app) {
        eprintln!("[PlaybackCommand] Failed to emit queue-changed: {error}");
    }
}

pub(crate) fn queue_position_payload(queue: &PlaybackQueue) -> QueuePositionPayload {
    QueuePositionPayload {
        current_index: queue.get_current_index(),
    }
}

pub(crate) fn emit_queue_position_changed(app: &AppHandle, payload: &QueuePositionPayload) {
    if playback_debug_enabled() {
        eprintln!(
            "[PlaybackCommand] queue-position-changed current_index={:?}",
            payload.current_index
        );
    }
    if let Err(error) = QueuePositionChanged(payload.clone()).emit(app) {
        eprintln!("[PlaybackCommand] Failed to emit queue-position-changed: {error}");
    }
}
