// ============================================
// Viby — Tauri IPC Helpers
// Wrappers for communicating with the Rust backend
// ============================================

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Track, Album, Artist, Playlist, PlaybackState, SearchResults, ScanProgress, TrackProgress } from '../types';

// ── Playback Commands ──

export async function playTrack(path: string): Promise<void> {
  return invoke('play_track', { path });
}

export async function pausePlayback(): Promise<void> {
  return invoke('pause');
}

export async function resumePlayback(): Promise<void> {
  return invoke('resume');
}

export async function stopPlayback(): Promise<void> {
  return invoke('stop');
}

export async function seekTo(positionSecs: number): Promise<void> {
  return invoke('seek', { positionSecs });
}

export async function setVolume(volume: number): Promise<void> {
  return invoke('set_volume', { volume });
}

export async function getPlaybackState(): Promise<PlaybackState> {
  return invoke('get_playback_state');
}

export async function nextTrack(): Promise<void> {
  return invoke('next_track');
}

export async function previousTrack(): Promise<void> {
  return invoke('previous_track');
}

export async function setShuffle(enabled: boolean): Promise<void> {
  return invoke('set_shuffle', { enabled });
}

export async function setRepeat(mode: 'off' | 'one' | 'all'): Promise<void> {
  return invoke('set_repeat', { mode });
}

// ── Library Commands ──

export async function addLibraryFolder(path: string): Promise<void> {
  return invoke('add_library_folder', { path });
}

export async function removeLibraryFolder(path: string): Promise<void> {
  return invoke('remove_library_folder', { path });
}

export async function scanLibrary(): Promise<void> {
  return invoke('scan_library');
}

export async function getAllTracks(): Promise<Track[]> {
  return invoke('get_all_tracks');
}

export async function getAlbums(): Promise<Album[]> {
  return invoke('get_albums');
}

export async function getArtists(): Promise<Artist[]> {
  return invoke('get_artists');
}

export async function getGenres(): Promise<string[]> {
  return invoke('get_genres');
}

export async function searchLibrary(query: string): Promise<SearchResults> {
  return invoke('search_library', { query });
}

export async function getTrackArtwork(trackId: string): Promise<string | null> {
  return invoke('get_track_artwork', { trackId });
}

// ── Playlist Commands ──

export async function createPlaylist(name: string): Promise<Playlist> {
  return invoke('create_playlist', { name });
}

export async function deletePlaylist(id: string): Promise<void> {
  return invoke('delete_playlist', { id });
}

export async function renamePlaylist(id: string, name: string): Promise<void> {
  return invoke('rename_playlist', { id, name });
}

export async function getPlaylists(): Promise<Playlist[]> {
  return invoke('get_playlists');
}

export async function getPlaylistTracks(playlistId: string): Promise<Track[]> {
  return invoke('get_playlist_tracks', { playlistId });
}

export async function addToPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
  return invoke('add_to_playlist', { playlistId, trackIds });
}

export async function removeFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  return invoke('remove_from_playlist', { playlistId, trackId });
}

// ── Event Listeners ──

/** Listen for real-time track progress updates from the audio engine */
export function onTrackProgress(callback: (progress: TrackProgress) => void): Promise<UnlistenFn> {
  return listen<TrackProgress>('track-progress', (event) => {
    callback(event.payload);
  });
}

/** Listen for playback state changes (play/pause/stop) */
export function onPlaybackStateChange(callback: (state: PlaybackState) => void): Promise<UnlistenFn> {
  return listen<PlaybackState>('playback-state-changed', (event) => {
    callback(event.payload);
  });
}

/** Listen for library scan progress */
export function onScanProgress(callback: (progress: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>('scan-progress', (event) => {
    callback(event.payload);
  });
}
