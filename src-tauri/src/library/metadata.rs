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
use std::time::{Duration, UNIX_EPOCH};

use lofty::file::AudioFile;
use lofty::file::TaggedFileExt;
use lofty::picture::PictureType;
use lofty::tag::{Accessor, ItemKey, ItemValue};

use crate::models::TrackMetadata;

pub const MAX_ARTWORK_BYTES: usize = 20 * 1024 * 1024;

/// Extract metadata from an audio file without reading artwork bytes.
///
/// Used during library scanning where artwork is deferred to first request.
/// Skipping artwork extraction reduces memory usage and parse time per file
/// — embedded JPEGs can be several MB each.
pub fn extract_metadata_no_artwork(file_path: &str) -> Result<TrackMetadata, String> {
    extract_metadata_impl(file_path, false)
}

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
    extract_metadata_impl(file_path, true)
}

fn extract_metadata_impl(file_path: &str, include_artwork: bool) -> Result<TrackMetadata, String> {
    let path = Path::new(file_path);

    // Get the file size before reading tags
    let file_metadata = std::fs::metadata(path).ok();
    let file_size = file_metadata.as_ref().map(|m| m.len() as i64).unwrap_or(0);
    let file_modified_unix = file_metadata
        .and_then(|m| m.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64);

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
        let title = tag.title().map(|s| s.to_string()).unwrap_or(fallback_title);

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
        let year = tag.year().map(|y| y as i32);
        let (replaygain_track_gain, replaygain_track_peak) = extract_replaygain(tag);
        let normalization_source = replaygain_track_gain.map(|_| "tag".to_string());

        // Extract album artwork (embedded cover image).
        // We look for the "Front Cover" picture type first.
        let artwork = include_artwork
            .then(|| {
                tag.pictures()
                    .iter()
                    .find(|picture| picture.pic_type() == PictureType::CoverFront)
                    .or_else(|| tag.pictures().first())
                    .filter(|picture| picture.data().len() <= MAX_ARTWORK_BYTES)
                    .map(|picture| picture.data().to_vec())
            })
            .flatten();

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
            replaygain_track_gain,
            replaygain_track_peak,
            normalization_source,
            file_modified_unix,
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
            replaygain_track_gain: None,
            replaygain_track_peak: None,
            normalization_source: None,
            file_modified_unix,
            artwork: None,
        })
    }
}

fn extract_replaygain(tag: &lofty::tag::Tag) -> (Option<f32>, Option<f32>) {
    let gain = first_tag_string(tag, &[ItemKey::ReplayGainTrackGain])
        .or_else(|| custom_tag_string(tag, "REPLAYGAIN_TRACK_GAIN"))
        .and_then(|value| parse_replaygain_gain_db(&value));

    let peak = first_tag_string(tag, &[ItemKey::ReplayGainTrackPeak])
        .or_else(|| custom_tag_string(tag, "REPLAYGAIN_TRACK_PEAK"))
        .and_then(|value| parse_replaygain_peak(&value));

    (gain, peak)
}

fn first_tag_string(tag: &lofty::tag::Tag, keys: &[ItemKey]) -> Option<String> {
    keys.iter()
        .find_map(|key| tag.get_string(key).map(|value| value.to_string()))
}

fn custom_tag_string(tag: &lofty::tag::Tag, name: &str) -> Option<String> {
    tag.items().find_map(|item| {
        let ItemKey::Unknown(key) = item.key() else {
            return None;
        };
        if !key.eq_ignore_ascii_case(name) {
            return None;
        }
        match item.value() {
            ItemValue::Text(value) => Some(value.to_string()),
            _ => None,
        }
    })
}

pub(crate) fn parse_replaygain_gain_db(raw: &str) -> Option<f32> {
    let value = raw
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_alphabetic())
        .trim();
    value.parse::<f32>().ok().filter(|gain| gain.is_finite())
}

pub(crate) fn parse_replaygain_peak(raw: &str) -> Option<f32> {
    raw.trim()
        .parse::<f32>()
        .ok()
        .filter(|peak| peak.is_finite() && *peak > 0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_replaygain_gain_with_db_suffix() {
        assert_eq!(parse_replaygain_gain_db(" -5.23 dB "), Some(-5.23));
        assert_eq!(parse_replaygain_gain_db("+3.0DB"), Some(3.0));
        assert_eq!(parse_replaygain_gain_db("nope"), None);
    }

    #[test]
    fn parses_replaygain_peak_as_positive_linear_value() {
        assert_eq!(parse_replaygain_peak("0.987"), Some(0.987));
        assert_eq!(parse_replaygain_peak("0"), None);
        assert_eq!(parse_replaygain_peak("nan"), None);
    }
}
