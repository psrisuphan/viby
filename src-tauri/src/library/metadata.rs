// =============================================================================
// library/metadata.rs — Audio metadata extraction using lofty
// =============================================================================
//
// This module reads metadata tags (title, artist, album, etc.) from audio files.
// Different audio formats use different tag systems:
//   - MP3 uses ID3v2 tags
//   - FLAC/OGG use Vorbis Comments
//   - M4A/AAC use MP4 atoms
//   - WAV uses RIFF INFO or ID3
//
// The `lofty` crate provides a unified API that handles all of these.
//
// Key Rust concepts:
//   - `Result<T, E>` → like a Promise that resolves to T or rejects with E
//   - `?` operator → early return on error (like throwing in JS try/catch)
//   - `unwrap_or` → provide a default value if None (like ?? in JS)
// =============================================================================

use std::path::Path;
use std::time::Duration;

use lofty::file::AudioFile;
use lofty::file::TaggedFileExt;
use lofty::picture::PictureType;
use lofty::tag::Accessor;

use crate::models::TrackMetadata;

/// Extract metadata from an audio file.
///
/// This reads the file's tags (ID3, Vorbis Comments, etc.) and returns
/// a `TrackMetadata` struct. If tags are missing, sensible defaults are used
/// (e.g., the filename becomes the title).
///
/// # Arguments
/// * `file_path` — absolute path to the audio file
///
/// # Returns
/// * `Ok(TrackMetadata)` — successfully extracted metadata
/// * `Err(String)` — something went wrong (file not found, corrupt tags, etc.)
///
/// # Example
/// ```ignore
/// let meta = extract_metadata("/Users/me/Music/song.mp3")?;
/// println!("Now playing: {} by {}", meta.title, meta.artist);
/// ```
pub fn extract_metadata(file_path: &str) -> Result<TrackMetadata, String> {
    let path = Path::new(file_path);

    // Get the file size before reading tags
    let file_size = std::fs::metadata(path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    // Read the tagged file. lofty::read_from_path automatically detects the format.
    let tagged_file = lofty::read_from_path(path)
        .map_err(|e| format!("Failed to read metadata from '{}': {}", file_path, e))?;

    // Get the "best" tag available. Different formats have different tag types.
    // primary_tag() returns the most appropriate one (e.g., ID3v2 for MP3).
    // If that's not available, first_tag() returns whatever is there.
    let tag = tagged_file
        .primary_tag()
        .or_else(|| tagged_file.first_tag());

    // Get the audio properties (duration, bitrate, sample rate, etc.)
    let properties = tagged_file.properties();
    let duration: Duration = properties.duration();
    let duration_secs = duration.as_secs_f64();

    // Extract the filename without extension — used as fallback title
    let fallback_title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    // If we have a tag, read from it; otherwise use defaults
    if let Some(tag) = tag {
        // Read common fields.
        // tag.title() etc. return Option<Cow<str>> — like a smart string reference.
        // .as_deref() converts to Option<&str>, then unwrap_or provides a default.
        let title = tag
            .title()
            .map(|s| s.to_string())
            .unwrap_or(fallback_title);

        let artist = tag
            .artist()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Unknown Artist".to_string());

        let album = tag
            .album()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Unknown Album".to_string());

        let genre = tag
            .genre()
            .map(|s| s.to_string())
            .unwrap_or_else(|| "Unknown".to_string());

        // Album artist — not available via the Accessor trait directly.
        // We use ItemKey to get it from the generic tag items.
        let album_artist = tag
            .get_string(&lofty::tag::ItemKey::AlbumArtist)
            .map(|s| s.to_string())
            .unwrap_or_else(|| artist.clone());

        // Track number and disc number.
        // In lofty 0.22, track() and disk() return Option<u32>.
        let track_number = tag.track();
        let disc_number = tag.disk();

        // Year — In lofty 0.22, year() was replaced with the date() accessor.
        // We try to get year from common tag items.
        let year = tag
            .year()
            .map(|y| y as i32);

        // Extract album artwork (embedded cover image).
        // We look for the "Front Cover" picture type first.
        let artwork = tag
            .pictures()
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .or_else(|| tag.pictures().first())
            .map(|p| p.data().to_vec());

        Ok(TrackMetadata {
            title,
            artist,
            album,
            album_artist,
            genre,
            year,
            track_number,
            disc_number,
            duration_secs,
            file_path: file_path.to_string(),
            file_size,
            artwork,
        })
    } else {
        // No tags found at all — use defaults
        Ok(TrackMetadata {
            title: fallback_title,
            artist: "Unknown Artist".to_string(),
            album: "Unknown Album".to_string(),
            album_artist: "Unknown Artist".to_string(),
            genre: "Unknown".to_string(),
            year: None,
            track_number: None,
            disc_number: None,
            duration_secs,
            file_path: file_path.to_string(),
            file_size,
            artwork: None,
        })
    }
}
