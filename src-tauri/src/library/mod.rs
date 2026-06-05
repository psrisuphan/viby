// =============================================================================
// library/mod.rs — Module declarations for the library subsystem
// =============================================================================

/// File system scanner — finds audio files recursively
pub mod scanner;

/// Metadata extraction — reads tags from audio files using lofty
pub mod metadata;

/// SQLite database — stores the indexed music library
pub mod database;
