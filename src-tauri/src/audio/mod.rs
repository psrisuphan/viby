// =============================================================================
// audio/mod.rs — Module declarations for the audio subsystem
// =============================================================================
//
// In Rust, mod.rs acts like an "index.ts" barrel file — it declares which
// sub-modules exist and re-exports their public items for convenience.
// =============================================================================

/// Core audio playback engine — manages rodio Sink in a dedicated thread
pub mod player;

/// Artwork and file-URI helpers for system media-control metadata
pub(crate) mod media;

/// 10-band graphic equalizer (biquad IIR filter cascade)
pub mod eq;

/// Playback queue — manages track ordering, shuffle, and repeat
pub mod queue;

/// Audiophile-grade DSP engine (TDF2 biquads, SVF, oversampling)
pub mod dsp;

/// Custom Symphonia decoder that supports seeking FLAC and MP3 files
pub mod decoder;

/// Output stream selection and status reporting
pub mod output;

/// ReplayGain/Sound Check source wrapper and analyzer
pub mod normalization;
