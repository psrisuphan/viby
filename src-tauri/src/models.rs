// =============================================================================
// models.rs — Shared data types for the entire Viby backend
// =============================================================================
//
// Think of this file like a TypeScript "types.ts" — it defines all the shapes
// of data that flow between modules. In Rust, we use `struct` instead of
// `interface`, and we "derive" traits (like auto-implementing interfaces)
// to get superpowers like JSON serialization.
//
// Key Rust concepts used here:
//   - `#[derive(...)]`  → auto-generates code. Serialize/Deserialize = JSON support
//   - `Option<T>`       → like TypeScript's `T | null` — the value might be missing
//   - `String`          → owned string (like JS string)
//   - `Vec<T>`          → like JavaScript `Array<T>`
//   - `pub`             → makes the field public (accessible from other modules)
// =============================================================================

use serde::{Deserialize, Serialize};

// -----------------------------------------------------------------------------
// Track — represents a single audio file in the library
// -----------------------------------------------------------------------------

/// A single track (song) in the music library.
/// This is the main data type that flows between the database, scanner, and frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Track {
    /// Unique identifier (UUID v4)
    pub id: String,
    /// Song title — falls back to filename if missing from metadata
    pub title: String,
    /// Artist name — "Unknown Artist" if missing
    pub artist: String,
    /// Album name — "Unknown Album" if missing
    pub album: String,
    /// Album artist — often different from track artist on compilations
    pub album_artist: String,
    /// Genre tag — "Unknown" if missing
    pub genre: String,
    /// Release year — None if not specified in metadata
    pub year: Option<i32>,
    /// Track number within the album — None if not specified
    pub track_number: Option<u32>,
    /// Disc number for multi-disc albums — None if not specified
    pub disc_number: Option<u32>,
    /// Duration in seconds (fractional, e.g. 245.5)
    pub duration_secs: f64,
    /// Absolute path to the audio file on disk
    pub file_path: String,
    /// File size in bytes
    pub file_size: i64,
    /// ReplayGain/Sound Check gain in dB, either from tags or background analysis
    pub replaygain_track_gain: Option<f32>,
    /// Track peak as a linear full-scale ratio, used to cap positive gain
    pub replaygain_track_peak: Option<f32>,
    /// Where the normalization data came from: "tag", "analysis", or None
    #[serde(skip_serializing, skip_deserializing)]
    pub normalization_source: Option<String>,
    /// File modification timestamp used to detect changed files during scan
    #[serde(skip_serializing, skip_deserializing)]
    pub file_modified_unix: Option<i64>,
    /// ISO 8601 timestamp of when this track was added to the library
    pub date_added: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackEqOverride {
    pub track_id: String,
    pub enabled: bool,
    pub preamp_db: f32,
    pub gains: Vec<f32>,
    pub updated_at: String,
}

// -----------------------------------------------------------------------------
// Album — represents a group of tracks sharing the same album name + artist
// -----------------------------------------------------------------------------

/// An album in the music library, aggregated from track metadata.
/// Not stored directly in the database — computed from track data.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Album {
    /// Album name
    pub name: String,
    /// Primary artist for this album
    pub artist: String,
    /// Release year — None if not available
    pub year: Option<i32>,
    /// How many tracks belong to this album
    pub track_count: u32,
    /// ID of a track that has artwork — used to fetch album cover
    pub artwork_track_id: Option<String>,
}

// -----------------------------------------------------------------------------
// Artist — represents a unique artist in the library
// -----------------------------------------------------------------------------

/// An artist, aggregated from track metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artist {
    /// Artist name
    pub name: String,
    /// How many albums this artist has
    pub album_count: u32,
    /// Total track count across all albums
    pub track_count: u32,
}

// -----------------------------------------------------------------------------
// Playlist — a user-created collection of tracks
// -----------------------------------------------------------------------------

/// A user-created playlist.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Playlist {
    /// Unique identifier (UUID v4)
    pub id: String,
    /// User-chosen name for the playlist
    pub name: String,
    /// Number of tracks in this playlist
    pub track_count: u32,
    /// ISO 8601 timestamp of when the playlist was created
    pub created_at: String,
    /// ISO 8601 timestamp of last modification
    pub updated_at: String,
}

// -----------------------------------------------------------------------------
// PlaybackState — snapshot of what's currently playing and how
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioPathStatus {
    pub source_sample_rate: Option<u32>,
    pub source_channels: Option<u32>,
    pub source_bits_per_sample: Option<u32>,
    pub output_sample_rate: Option<u32>,
    pub output_channels: Option<u32>,
    pub output_sample_format: Option<String>,
    pub dsp_enabled: bool,
    pub eq_mode: String,
    pub app_gain: f32,
    pub resampling_active: bool,
    pub status: String,
    pub fallback_reason: Option<String>,
}

impl AudioPathStatus {
    pub fn idle() -> Self {
        Self {
            source_sample_rate: None,
            source_channels: None,
            source_bits_per_sample: None,
            output_sample_rate: None,
            output_channels: None,
            output_sample_format: None,
            dsp_enabled: false,
            eq_mode: "graphic".to_string(),
            app_gain: 1.0,
            resampling_active: false,
            status: "idle".to_string(),
            fallback_reason: None,
        }
    }
}

/// Current playback state — sent to the frontend so the UI can stay in sync.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlaybackState {
    /// Whether audio is currently playing (true) or paused/stopped (false)
    pub is_playing: bool,
    /// The track currently loaded — None if nothing is loaded
    pub current_track: Option<Track>,
    /// Current playback position in seconds
    pub position_secs: f64,
    /// Total duration of the current track in seconds
    pub duration_secs: f64,
    /// Volume level from 0.0 (silent) to 1.0 (full volume)
    pub volume: f32,
    /// Whether shuffle mode is enabled
    pub shuffle: bool,
    /// Repeat mode: "off", "one", or "all"
    pub repeat_mode: String,
    /// Native sample rate of the current track in Hz
    pub sample_rate: Option<u32>,
    /// Number of audio channels in the current track
    pub channels: Option<u32>,
    /// Bit depth of the current track (bits per sample)
    pub bits_per_sample: Option<u32>,
    /// Source/output/DSP path details used to report actual playback quality.
    pub audio_path: AudioPathStatus,
}

// -----------------------------------------------------------------------------
// SearchResults — returned from the search command
// -----------------------------------------------------------------------------

/// Search results containing matching tracks, albums, and artists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResults {
    pub tracks: Vec<Track>,
    pub albums: Vec<Album>,
    pub artists: Vec<Artist>,
}

// -----------------------------------------------------------------------------
// TrackMetadata — raw metadata extracted from an audio file
// -----------------------------------------------------------------------------

/// Raw metadata extracted from an audio file by lofty.
/// This is an intermediate type — we convert it into a Track when storing in the DB.
/// (Not sent to the frontend directly, so no Serialize/Deserialize needed,
///  but we include them anyway for flexibility.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackMetadata {
    /// Song title
    pub title: String,
    /// Artist name
    pub artist: String,
    /// Album name
    pub album: String,
    /// Album artist (may differ from artist on compilations)
    pub album_artist: String,
    /// Genre
    pub genre: String,
    /// Release year
    pub year: Option<i32>,
    /// Track number
    pub track_number: Option<u32>,
    /// Disc number
    pub disc_number: Option<u32>,
    /// Duration in seconds
    pub duration_secs: f64,
    /// Absolute file path
    pub file_path: String,
    /// File size in bytes
    pub file_size: i64,
    /// ReplayGain/Sound Check gain in dB, if present in tags
    pub replaygain_track_gain: Option<f32>,
    /// ReplayGain/Sound Check peak as a linear full-scale ratio, if present in tags
    pub replaygain_track_peak: Option<f32>,
    /// Where the normalization data came from: "tag" or None
    pub normalization_source: Option<String>,
    /// File modification timestamp used to detect changed files during scan
    pub file_modified_unix: Option<i64>,
    /// Embedded album artwork as raw bytes (e.g., JPEG/PNG data)
    /// None if the file has no embedded artwork
    pub artwork: Option<Vec<u8>>,
}

// -----------------------------------------------------------------------------
// RepeatMode — enum for repeat behavior
// -----------------------------------------------------------------------------

/// Repeat mode for the playback queue.
/// In Rust, enums are like TypeScript's discriminated unions — each variant
/// is a distinct state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RepeatMode {
    /// No repeat — stop at end of queue
    Off,
    /// Repeat the current track forever
    One,
    /// Repeat the entire queue when it reaches the end
    All,
}

impl RepeatMode {
    /// Convert a string (from the frontend) into a RepeatMode.
    /// Defaults to Off for unrecognized strings.
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "one" => RepeatMode::One,
            "all" => RepeatMode::All,
            _ => RepeatMode::Off,
        }
    }

    /// Convert a RepeatMode into a string (to send to the frontend).
    pub fn as_str(&self) -> &'static str {
        match self {
            RepeatMode::Off => "off",
            RepeatMode::One => "one",
            RepeatMode::All => "all",
        }
    }
}

// -----------------------------------------------------------------------------
// QueuePayload — sent to the frontend to sync the queue state
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuePayload {
    pub tracks: Vec<Track>,
    pub current_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuePositionPayload {
    pub current_index: Option<usize>,
}

// -----------------------------------------------------------------------------
// TopArtist — an artist ranked by play count from play history
// -----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopArtist {
    pub name: String,
    pub play_count: i64,
    /// ID of any track by this artist — used to fetch artwork
    pub artwork_track_id: Option<String>,
    /// Album and album_artist of the representative track — used as the
    /// frontend artwork cache key so ArtistCards reuse existing album entries.
    pub artwork_album: Option<String>,
    pub artwork_album_artist: Option<String>,
}
