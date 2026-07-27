// =============================================================================
// library/scanner.rs — File system scanner for audio files
// =============================================================================
//
// This module walks through directories recursively to find audio files.
// It's like doing a recursive `fs.readdir` in Node.js, but using the
// `walkdir` crate which handles all the OS-specific edge cases.
//
// Supported formats: MP3, FLAC, WAV, OGG, OPUS, AAC, M4A, MP4, AIFF, M4B
// =============================================================================

use std::path::Path;
use walkdir::WalkDir;

/// List of audio file extensions we support.
/// These are checked case-insensitively.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "ogg", "opus", "aac", "m4a", "mp4", "aiff", "aif", "m4b",
];

/// Check if a file path has a supported audio extension.
///
/// # Arguments
/// * `path` — the file path to check
///
/// # Returns
/// `true` if the file extension matches one of our supported formats
pub(crate) fn is_audio_file(path: &Path) -> bool {
    // Get the file extension, convert to lowercase, and check if it's in our list.
    // This is like: path.split('.').pop()?.toLowerCase() in JavaScript
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| AUDIO_EXTENSIONS.contains(&ext.to_lowercase().as_str()))
        .unwrap_or(false)
}

/// Scan a directory recursively for audio files.
///
/// # Arguments
/// * `dir_path` — absolute path to the directory to scan
///
/// # Returns
/// Absolute paths to all audio files, or the first filesystem error.
///
/// # Example
/// ```ignore
/// let files = scan_directory("/Users/me/Music");
/// // files = ["/Users/me/Music/song.mp3", "/Users/me/Music/album/track.flac", ...]
/// ```
pub fn scan_directory(dir_path: &str) -> Result<Vec<String>, String> {
    let mut audio_files = Vec::new();

    // WalkDir recursively walks through all subdirectories.
    // .follow_links(true) follows symbolic links (like symlinks in Unix).
    // .into_iter() turns it into an iterator we can loop over.
    // .filter_map(|e| e.ok()) silently skips entries we can't read
    // (e.g., permission denied).
    for entry in WalkDir::new(dir_path).follow_links(true) {
        let entry = entry.map_err(|error| format!("Failed to scan {dir_path}: {error}"))?;
        let path = entry.path();

        // Only include regular files (not directories or symlinks themselves)
        if path.is_file() && is_audio_file(path) {
            // Convert the path to a String.
            // to_string_lossy() handles non-UTF8 filenames gracefully
            // (replaces invalid chars with '�' — very rare on modern systems).
            audio_files.push(path.to_string_lossy().to_string());
        }
    }

    Ok(audio_files)
}
