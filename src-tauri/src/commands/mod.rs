// =============================================================================
// commands/mod.rs — Module declarations for Tauri command handlers
// =============================================================================

/// Playback commands — play, pause, seek, volume, etc.
pub mod playback;

/// Target-curve and headphone-measurement commands.
pub mod curves;

/// Queue event payloads shared by playback commands and the audio thread.
pub(crate) mod queue_events;

/// Library commands — scan folders, search tracks, get albums/artists
pub mod library;

/// Playlist commands — create, delete, add/remove tracks
pub mod playlist;
