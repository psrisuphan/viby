// ============================================
// Viby — Tauri IPC Helpers
// Wrappers for communicating with the Rust backend
// ============================================

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { Track, Album, Artist, Playlist, PlaybackState, SearchResults, ScanProgress, TrackProgress, QueuePayload } from '../types';

// ── Playback Commands ──

export async function playTrack(trackId: string): Promise<void> {
  return invoke('play_track', { trackId });
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

export async function nextTrack(userInitiated: boolean): Promise<void> {
  await invoke('next_track', { userInitiated: userInitiated, user_initiated: userInitiated });
}

export async function previousTrack(userInitiated: boolean): Promise<void> {
  await invoke('previous_track', { userInitiated: userInitiated, user_initiated: userInitiated });
}

export async function setShuffle(enabled: boolean): Promise<void> {
  return invoke('set_shuffle', { enabled });
}

export async function setRepeat(mode: 'off' | 'one' | 'all'): Promise<void> {
  return invoke('set_repeat', { mode });
}

// ── Queue Commands ──

export const getQueue = async (): Promise<QueuePayload> => {
  return await invoke('get_queue');
};

export const addToQueue = async (track: Track): Promise<void> => {
  await invoke('add_to_queue', { track });
};

export const removeFromQueue = async (index: number): Promise<void> => {
  await invoke('remove_from_queue', { index });
};

export const reorderQueue = async (oldIndex: number, newIndex: number): Promise<void> => {
  await invoke('reorder_queue', { from: oldIndex, to: newIndex });
};

export const clearQueue = async (): Promise<void> => {
  await invoke('clear_all');
};

export const clearUpNext = async (): Promise<void> => {
  await invoke('clear_up_next');
};

export const clearHistory = async (): Promise<void> => {
  return invoke('clear_history');
};

export const playQueueIndex = async (index: number): Promise<void> => {
  await invoke('play_queue_index', { index });
};

// ============================================
// Playlists API
// ============================================

export const createPlaylist = async (name: string): Promise<Playlist> => {
  return await invoke('create_playlist', { name });
};

export const deletePlaylist = async (id: string): Promise<void> => {
  await invoke('delete_playlist', { id });
};

export const renamePlaylist = async (id: string, name: string): Promise<void> => {
  await invoke('rename_playlist', { id, name });
};

export const getPlaylists = async (): Promise<Playlist[]> => {
  return await invoke('get_playlists');
};

export const getPlaylistTracks = async (playlistId: string): Promise<Track[]> => {
  return await invoke('get_playlist_tracks', { playlistId });
};

export const addToPlaylist = async (playlistId: string, trackIds: string[]): Promise<void> => {
  await invoke('add_to_playlist', { playlistId, trackIds });
};

export const removeFromPlaylist = async (playlistId: string, trackId: string): Promise<void> => {
  await invoke('remove_from_playlist', { playlistId, trackId });
};

export const reorderPlaylist = async (playlistId: string, trackIds: string[]): Promise<void> => {
  await invoke('reorder_playlist', { playlistId, trackIds });
};

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
  return invoke('search', { query });
}

export interface ArtworkPayload {
  data: string;
  mime_type: string;
}

export async function getTrackArtwork(trackId: string): Promise<ArtworkPayload | null> {
  return invoke('get_track_artwork', { trackId });
}

// ── Playlist Commands ──
// (implemented above)

// ── Event Listeners ──

/** Listen for real-time track progress updates from the audio engine */
export function onTrackProgress(callback: (progress: TrackProgress) => void): Promise<UnlistenFn> {
  return listen<TrackProgress>('track-progress', (event) => {
    callback(event.payload);
  });
}

/** Listen for playback state changes (play/pause/stop) */
export function onPlaybackStateChange(callback: (state: PlaybackState) => void): Promise<UnlistenFn> {
  return listen<PlaybackState>('playback-state', (event) => {
    callback(event.payload);
  });
}

/** Listen for when a track finishes playing naturally */
export function onTrackEnded(callback: () => void): Promise<UnlistenFn> {
  return listen<string>('track-ended', () => {
    callback();
  });
}

/** Listen for library scan progress */
export function onScanProgress(callback: (progress: ScanProgress) => void): Promise<UnlistenFn> {
  return listen<ScanProgress>('scan-progress', (event) => {
    callback(event.payload);
  });
}

/** Listen for queue updates */
export function onQueueChanged(callback: (payload: QueuePayload) => void): Promise<UnlistenFn> {
  return listen<QueuePayload>('queue-changed', (event) => {
    callback(event.payload);
  });
}
