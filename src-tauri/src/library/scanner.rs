// =============================================================================
// library/scanner.rs — File system scanner for audio files
// =============================================================================
//
// This module walks through directories recursively to find audio files.
// It's like doing a recursive `fs.readdir` in Node.js, but using the
// `walkdir` crate which handles all the OS-specific edge cases.
//
// Supported formats: MP3, FLAC, WAV, OGG, AAC, M4A, WMA, AIFF, ALAC
// =============================================================================

use std::path::Path;
use walkdir::WalkDir;

/// List of audio file extensions we support.
/// These are checked case-insensitively.
const AUDIO_EXTENSIONS: &[&str] = &[
    "mp3", "flac", "wav", "ogg", "aac", "m4a", "wma", "aiff", "aif", "alac",
];

/// Check if a file path has a supported audio extension.
///
/// # Arguments
/// * `path` — the file path to check
///
/// # Returns
/// `true` if the file extension matches one of our supported formats
fn is_audio_file(path: &Path) -> bool {
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
/// A `Vec<String>` of absolute paths to all audio files found.
///
/// # Example
/// ```ignore
/// let files = scan_directory("/Users/me/Music");
/// // files = ["/Users/me/Music/song.mp3", "/Users/me/Music/album/track.flac", ...]
/// ```
pub fn scan_directory(dir_path: &str) -> Vec<String> {
    let mut audio_files = Vec::new();

    // WalkDir recursively walks through all subdirectories.
    // .follow_links(true) follows symbolic links (like symlinks in Unix).
    // .into_iter() turns it into an iterator we can loop over.
    // .filter_map(|e| e.ok()) silently skips entries we can't read
    // (e.g., permission denied).
    for entry in WalkDir::new(dir_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        // Only include regular files (not directories or symlinks themselves)
        if path.is_file() && is_audio_file(path) {
            // Convert the path to a String.
            // to_string_lossy() handles non-UTF8 filenames gracefully
            // (replaces invalid chars with '�' — very rare on modern systems).
            audio_files.push(path.to_string_lossy().to_string());
        }
    }

    audio_files
}

/// Scan a directory and report progress via a callback.
/// This is useful for showing a progress bar in the UI during library scanning.
///
/// # Arguments
/// * `dir_path` — absolute path to the directory to scan
/// * `on_progress` — callback called with (files_found_so_far, current_file_path)
///
/// # Returns
/// A `Vec<String>` of all audio file paths found.
pub fn scan_directory_with_progress<F>(dir_path: &str, mut on_progress: F) -> Vec<String>
where
    F: FnMut(usize, &str),
{
    let mut audio_files = Vec::new();

    for entry in WalkDir::new(dir_path)
        .follow_links(true)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();

        if path.is_file() && is_audio_file(path) {
            let path_str = path.to_string_lossy().to_string();
            audio_files.push(path_str.clone());

            // Call the progress callback
            on_progress(audio_files.len(), &path_str);
        }
    }

    audio_files
}
