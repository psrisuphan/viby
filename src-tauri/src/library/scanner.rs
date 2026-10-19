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

use std::collections::HashSet;
use std::path::{Path, PathBuf};
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

/// Results from a fully completed walk, including subtrees that contained no
/// supported audio. Empty audio subtrees are protected from stale-track
/// pruning because they may be offline mounts hidden below a scanned root.
#[derive(Debug, Default)]
pub(crate) struct ScanDirectoryResult {
    pub audio_files: Vec<String>,
    pub audio_empty_subtrees: Vec<String>,
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
    Ok(scan_directory_with_subtrees(dir_path)?.audio_files)
}

/// Scan a directory and report directories that contain no supported audio
/// anywhere below them. A traversal error aborts the whole result so callers
/// cannot mistake an incomplete walk for proof that files disappeared.
pub(crate) fn scan_directory_with_subtrees(dir_path: &str) -> Result<ScanDirectoryResult, String> {
    let root = Path::new(dir_path);
    let mut audio_files = Vec::new();
    let mut directories = HashSet::<PathBuf>::new();

    // WalkDir recursively walks through all subdirectories.
    // .follow_links(true) follows symbolic links (like symlinks in Unix).
    // .into_iter() turns it into an iterator we can loop over.
    // .filter_map(|e| e.ok()) silently skips entries we can't read
    // (e.g., permission denied).
    for entry in WalkDir::new(dir_path).follow_links(true) {
        let entry = entry.map_err(|error| format!("Failed to scan {dir_path}: {error}"))?;
        let path = entry.path();

        if path.is_dir() {
            directories.insert(path.to_path_buf());
        }

        // Only include regular files (not directories or symlinks themselves)
        if path.is_file() && is_audio_file(path) {
            // Convert the path to a String.
            // to_string_lossy() handles non-UTF8 filenames gracefully
            // (replaces invalid chars with '�' — very rare on modern systems).
            audio_files.push(path.to_string_lossy().to_string());

            // Every ancestor directory up to the scan root contains audio and
            // therefore cannot be an offline/empty subtree boundary.
            let mut ancestor = path.parent();
            while let Some(directory) = ancestor {
                if !directory.starts_with(root) {
                    break;
                }
                directories.remove(directory);
                ancestor = directory.parent();
            }
        }
    }

    let mut audio_empty_subtrees: Vec<String> = directories
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect();
    audio_empty_subtrees.sort();

    Ok(ScanDirectoryResult {
        audio_files,
        audio_empty_subtrees,
    })
}
