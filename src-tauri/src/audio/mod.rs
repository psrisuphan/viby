// =============================================================================
// audio/mod.rs — Module declarations for the audio subsystem
// =============================================================================
//
// In Rust, mod.rs acts like an "index.ts" barrel file — it declares which
// sub-modules exist and re-exports their public items for convenience.
// =============================================================================

/// Core audio playback engine — manages rodio Sink in a dedicated thread
pub mod player;

/// Playback queue — manages track ordering, shuffle, and repeat
pub mod queue;
