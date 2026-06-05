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

/** Current playback state from the Rust backend */
export interface PlaybackState {
  is_playing: boolean;
  current_track: Track | null;
  position_secs: number;
  duration_secs: number;
  volume: number;
  shuffle: boolean;
  repeat_mode: RepeatMode;
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

/** Repeat mode options */
export type RepeatMode = 'off' | 'one' | 'all';

/** Library view mode options */
export type LibraryView = 'songs' | 'albums' | 'artists' | 'genres';

/** Sidebar navigation items */
export type SidebarSection = 'home' | 'library' | 'albums' | 'artists' | 'songs' | 'genres';

/** Scan progress event from Rust */
export interface ScanProgress {
  total_files: number;
  processed_files: number;
  current_file: string;
  status: 'scanning' | 'processing' | 'complete' | 'error';
}

/** Track progress event from Rust audio engine */
export interface TrackProgress {
  position_secs: number;
  duration_secs: number;
}
