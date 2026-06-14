// ============================================
// Viby — Type Definitions
// Shared types between frontend and Rust backend
// ============================================

/** Represents a single music track in the library */
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  album_artist: string;
  genre: string;
  year: number | null;
  track_number: number | null;
  disc_number: number | null;
  duration_secs: number;
  file_path: string;
  file_size: number;
  date_added: string;
}

/** Represents a music album (grouped from tracks) */
export interface Album {
  name: string;
  artist: string;
  year: number | null;
  track_count: number;
  artwork_track_id: string | null;
}

/** Represents a music artist (grouped from tracks) */
export interface Artist {
  name: string;
  album_count: number;
  track_count: number;
}

/** Represents a user-created playlist */
export interface Playlist {
  id: string;
  name: string;
  track_count: number;
  created_at: string;
  updated_at: string;
}

/** Actual source/output/DSP path from the Rust backend */
export interface AudioPathStatus {
  source_sample_rate: number | null;
  source_channels: number | null;
  source_bits_per_sample: number | null;
  output_sample_rate: number | null;
  output_channels: number | null;
  output_sample_format: string | null;
  dsp_enabled: boolean;
  eq_mode: 'graphic' | 'parametric' | string;
  app_gain: number;
  resampling_active: boolean;
  status: 'idle' | 'native' | 'native_dsp' | 'resampled_dsp' | 'fallback_device' | string;
  fallback_reason: string | null;
}

/** Current playback state from the Rust backend */
export interface PlaybackState {
  is_playing: boolean;
  current_track: Track | null;
  position_secs: number;
  duration_secs: number;
  volume: number;
  shuffle: boolean;
  repeat_mode: RepeatMode;
  sample_rate?: number;
  channels?: number;
  bits_per_sample?: number;
  audio_path?: AudioPathStatus;
}

/** Search results from the backend */
export interface SearchResults {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

/** Playback queue payload from Rust */
export interface QueuePayload {
  tracks: Track[];
  current_index: number | null;
}

/** Lightweight queue cursor update from Rust */
export interface QueuePositionPayload {
  current_index: number | null;
}

/** Repeat mode options */
export type RepeatMode = 'off' | 'one' | 'all';

/** Library view mode options */
export type LibraryView = 'songs' | 'albums' | 'artists' | 'genres';

/** Sidebar navigation items */
export type SidebarSection = 'home' | 'library' | 'albums' | 'artists' | 'songs' | 'genres' | 'playlist';

/** Scan progress event from Rust */
export interface ScanProgress {
  total_files: number;
  processed_files: number;
  current_file: string;
  status: 'scanning' | 'processing' | 'complete' | 'error';
  new_tracks?: number;
  removed_tracks?: number;
}

/** Track progress event from Rust audio engine */
export interface TrackProgress {
  position_secs: number;
  duration_secs: number;
}

/** An artist ranked by play count from the play history */
export interface TopArtist {
  name: string;
  play_count: number;
  artwork_track_id: string | null;
  artwork_album: string | null;
  artwork_album_artist: string | null;
}
