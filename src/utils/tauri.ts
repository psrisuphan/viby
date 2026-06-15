// ============================================
// Viby — Tauri IPC Helpers
// Wrappers for communicating with the Rust backend
// ============================================

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
	Track,
	Album,
	Artist,
	Playlist,
	PlaybackState,
	SearchResults,
	ScanProgress,
	TrackProgress,
	QueuePayload,
	QueuePositionPayload,
	TopArtist,
} from "../types";
import { useSettingsStore, type PeqBand } from "../stores/settingsStore";

// ── Playback Commands ──

export async function playTrack(trackId: string): Promise<void> {
	return invoke("play_track", { trackId });
}

export async function pausePlayback(): Promise<void> {
	return invoke("pause");
}

export async function resumePlayback(): Promise<void> {
	return invoke("resume");
}

export async function stopPlayback(): Promise<void> {
	return invoke("stop");
}

export async function seekTo(positionSecs: number): Promise<void> {
	return invoke("seek", { positionSecs });
}

const VOLUME_FLUSH_INTERVAL_MS = 50;
let pendingBackendVolume: number | null = null;
let volumeFlushTimer: ReturnType<typeof setTimeout> | null = null;
let volumeFlushInFlight = false;
let volumeFlushResolvers: Array<{
	resolve: () => void;
	reject: (error: unknown) => void;
}> = [];

function toBackendVolume(volume: number) {
	const displayVolume = Math.max(0, Math.min(1, volume));
	const { exponentialVolume } = useSettingsStore.getState();
	return exponentialVolume
		? displayVolume * displayVolume * displayVolume
		: displayVolume;
}

function clearVolumeFlushTimer() {
	if (volumeFlushTimer === null) return;
	clearTimeout(volumeFlushTimer);
	volumeFlushTimer = null;
}

function scheduleVolumeFlush(delayMs: number) {
	if (volumeFlushTimer !== null || volumeFlushInFlight) return;
	volumeFlushTimer = setTimeout(() => {
		volumeFlushTimer = null;
		void flushPendingVolume();
	}, delayMs);
}

async function flushPendingVolume(): Promise<void> {
	if (volumeFlushInFlight) {
		scheduleVolumeFlush(VOLUME_FLUSH_INTERVAL_MS);
		return;
	}

	clearVolumeFlushTimer();
	const volume = pendingBackendVolume;
	if (volume === null) return;

	const resolvers = volumeFlushResolvers;
	volumeFlushResolvers = [];
	pendingBackendVolume = null;
	volumeFlushInFlight = true;

	try {
		if (playbackDebugEnabled()) {
			console.info("[VibyDebug] flushed backend volume", { volume });
		}
		await invoke("set_volume", { volume });
		resolvers.forEach(({ resolve }) => resolve());
	} catch (error) {
		resolvers.forEach(({ reject }) => reject(error));
	} finally {
		volumeFlushInFlight = false;
		if (pendingBackendVolume !== null) {
			scheduleVolumeFlush(VOLUME_FLUSH_INTERVAL_MS);
		}
	}
}

export async function setVolume(
	volume: number,
	options: { immediate?: boolean } = {},
): Promise<void> {
	pendingBackendVolume = toBackendVolume(volume);
	const promise = new Promise<void>((resolve, reject) => {
		volumeFlushResolvers.push({ resolve, reject });
	});

	if (options.immediate) {
		void flushPendingVolume();
	} else {
		scheduleVolumeFlush(VOLUME_FLUSH_INTERVAL_MS);
	}

	return promise;
}

export async function setEq(
	enabled: boolean,
	preamp: number,
	gains: number[],
): Promise<void> {
	return invoke("set_eq", { enabled, preamp, gains });
}

export interface PeqBandParam {
	enabled: boolean;
	filter_type: number;
	freq: number;
	gain: number;
	q: number;
}

export async function setPeq(
	enabled: boolean,
	preamp: number,
	bands: PeqBandParam[],
): Promise<void> {
	return invoke("set_peq", { enabled, preamp, bands });
}

export interface TargetCurve {
	name: string;
	points: [number, number][];
}

export async function getTargetCurves(): Promise<TargetCurve[]> {
	return invoke("get_target_curves");
}

export async function importTargetCurve(
	filePath: string,
): Promise<TargetCurve> {
	return invoke("import_target_curve", { filePath });
}

export async function deleteTargetCurve(name: string): Promise<void> {
	return invoke("delete_target_curve", { name });
}

export async function getHeadphoneMeasurements(): Promise<TargetCurve[]> {
	return invoke("get_headphone_measurements");
}

export async function importHeadphoneMeasurement(
	filePath: string,
): Promise<TargetCurve> {
	return invoke("import_headphone_measurement", { filePath });
}

export async function deleteHeadphoneMeasurement(name: string): Promise<void> {
	return invoke("delete_headphone_measurement", { name });
}

export async function readTextFile(filePath: string): Promise<string> {
	return invoke("read_text_file", { filePath });
}

export async function getPlaybackState(): Promise<PlaybackState> {
	return invoke("get_playback_state");
}

function playbackDebugEnabled() {
	return (
		import.meta.env.DEV || localStorage.getItem("vibyDebugPlayback") === "1"
	);
}

// ── Skip batching — coalesces rapid next/previous clicks into one IPC call ──
let pendingSkipDelta = 0;
let pendingSkipResolvers: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
let isFlushingSkip = false;

function scheduleSkip(delta: number): Promise<void> {
  pendingSkipDelta += delta;

  const promise = new Promise<void>((resolve, reject) => {
    pendingSkipResolvers.push({ resolve, reject });
  });

  if (!isFlushingSkip) {
    isFlushingSkip = true;
    setTimeout(async () => {
      const skipDelta = pendingSkipDelta;
      const resolvers = pendingSkipResolvers;
      pendingSkipDelta = 0;
      pendingSkipResolvers = [];
      isFlushingSkip = false;

      try {
        if (skipDelta !== 0) {
          if (playbackDebugEnabled()) {
            console.info("[VibyDebug] batched user skip", { delta: skipDelta });
          }
          await invoke('skip_tracks', {
            delta: skipDelta,
            userInitiated: true,
            user_initiated: true,
          });
        }
        resolvers.forEach(({ resolve }) => resolve());
      } catch (error) {
        resolvers.forEach(({ reject }) => reject(error));
      }
    }, 120);
  }

  return promise;
}

export async function nextTrack(userInitiated: boolean): Promise<void> {
  if (userInitiated) {
    await scheduleSkip(1);
    return;
  }
  await invoke('next_track', { userInitiated, user_initiated: userInitiated });
}

export async function previousTrack(userInitiated: boolean): Promise<void> {
  if (userInitiated) {
    await scheduleSkip(-1);
    return;
  }
  await invoke('previous_track', { userInitiated, user_initiated: userInitiated });
}

export async function setShuffle(enabled: boolean): Promise<void> {
	return invoke("set_shuffle", { enabled });
}

export async function setRepeat(mode: "off" | "one" | "all"): Promise<void> {
	return invoke("set_repeat", { mode });
}

// ── Queue Commands ──

export const getQueue = async (): Promise<QueuePayload> => {
	return await invoke("get_queue");
};

export const addToQueue = async (track: Track): Promise<void> => {
	await invoke("add_to_queue", { track });
};

export const addTracksToQueue = async (tracks: Track[]): Promise<void> => {
	await invoke("add_tracks_to_queue", { tracks });
};

export const removeFromQueue = async (index: number): Promise<void> => {
	await invoke("remove_from_queue", { index });
};

export const reorderQueue = async (
	oldIndex: number,
	newIndex: number,
): Promise<void> => {
	await invoke("reorder_queue", { from: oldIndex, to: newIndex });
};

export const clearQueue = async (): Promise<void> => {
	await invoke("clear_all");
};

export const clearUpNext = async (): Promise<void> => {
	await invoke("clear_up_next");
};

export const clearHistory = async (): Promise<void> => {
	return invoke("clear_history");
};

export const playQueueIndex = async (index: number): Promise<void> => {
	await invoke("play_queue_index", { index });
};

// ============================================
// Playlists API
// ============================================

export const createPlaylist = async (name: string): Promise<Playlist> => {
	return await invoke("create_playlist", { name });
};

export const deletePlaylist = async (id: string): Promise<void> => {
	await invoke("delete_playlist", { id });
};

export const renamePlaylist = async (
	id: string,
	name: string,
): Promise<void> => {
	await invoke("rename_playlist", { id, name });
};

export const getPlaylists = async (): Promise<Playlist[]> => {
	return await invoke("get_playlists");
};

export const getPlaylistTracks = async (
	playlistId: string,
): Promise<Track[]> => {
	return await invoke("get_playlist_tracks", { playlistId });
};

export const addToPlaylist = async (
	playlistId: string,
	trackIds: string[],
): Promise<void> => {
	await invoke("add_to_playlist", { playlistId, trackIds });
};

export const removeFromPlaylist = async (
	playlistId: string,
	trackId: string,
): Promise<void> => {
	await invoke("remove_from_playlist", { playlistId, trackId });
};

export const reorderPlaylist = async (
	playlistId: string,
	trackIds: string[],
): Promise<void> => {
	await invoke("reorder_playlist", { playlistId, trackIds });
};

// ── Library Commands ──

export async function addLibraryFolder(path: string): Promise<void> {
	return invoke("add_library_folder", { path });
}

export async function removeLibraryFolder(path: string): Promise<void> {
	return invoke("remove_library_folder", { path });
}

export async function scanLibrary(): Promise<void> {
	return invoke("scan_library");
}

export async function getAllTracks(): Promise<Track[]> {
	return invoke("get_all_tracks");
}

export async function getAlbumTracks(
	album: string,
	albumArtist: string,
): Promise<Track[]> {
	return invoke("get_album_tracks", { album, albumArtist });
}

export async function getAlbums(): Promise<Album[]> {
	return invoke("get_albums");
}

export async function getArtists(): Promise<Artist[]> {
	return invoke("get_artists");
}

export async function getGenres(): Promise<string[]> {
	return invoke("get_genres");
}

export async function clearPlayHistory(): Promise<void> {
	return invoke("clear_play_history");
}

export async function getRecentlyPlayed(): Promise<Track[]> {
	return invoke("get_recently_played");
}

export async function getTopArtistsPlayed(): Promise<TopArtist[]> {
	return invoke("get_top_artists_played");
}

export async function getRecentlyAddedTracks(): Promise<Track[]> {
	return invoke("get_recently_added_tracks");
}

export async function searchLibrary(query: string): Promise<SearchResults> {
	return invoke("search", { query });
}

export interface ArtworkPayload {
	data: string;
	mime_type: string;
}

export async function getTrackArtwork(
	trackId: string,
): Promise<ArtworkPayload | null> {
	return invoke("get_track_artwork", { trackId });
}

// ── Playlist Commands ──
// (implemented above)

// ── Event Listeners ──

/** Listen for real-time track progress updates from the audio engine */
export function onTrackProgress(
	callback: (progress: TrackProgress) => void,
): Promise<UnlistenFn> {
	return listen<TrackProgress>("track-progress", (event) => {
		callback(event.payload);
	});
}

/** Listen for playback state changes (play/pause/stop) */
export function onPlaybackStateChange(
	callback: (state: PlaybackState) => void,
): Promise<UnlistenFn> {
	return listen<PlaybackState>("playback-state", (event) => {
		callback(event.payload);
	});
}

/** Listen for when a track finishes playing naturally */
export function onTrackEnded(callback: () => void): Promise<UnlistenFn> {
	return listen<string>("track-ended", () => {
		callback();
	});
}

/** Listen for library scan progress */
export function onScanProgress(
	callback: (progress: ScanProgress) => void,
): Promise<UnlistenFn> {
	return listen<ScanProgress>("scan-progress", (event) => {
		callback(event.payload);
	});
}

/** Listen for queue updates */
export function onQueueChanged(
	callback: (payload: QueuePayload) => void,
): Promise<UnlistenFn> {
	return listen<QueuePayload>("queue-changed", (event) => {
		callback(event.payload);
	});
}

/** Listen for lightweight queue cursor updates */
export function onQueuePositionChanged(
	callback: (payload: QueuePositionPayload) => void,
): Promise<UnlistenFn> {
	return listen<QueuePositionPayload>("queue-position-changed", (event) => {
		callback(event.payload);
	});
}

export async function runAutoEqBackend(
	measurement: TargetCurve,
	target: TargetCurve,
	bandsToOptimize: PeqBand[],
): Promise<{ bands: PeqBand[]; preamp: number; loss: number; maxResponseDb: number }> {
	return invoke("run_autoeq", {
		measurement,
		target,
		bandsToOptimize,
		options: {
			config: "standard",
			smooth: "oe",
			steps: 3000,
			sampleRate: 48000,
		},
	});
}

export async function setGpuAcceleration(enabled: boolean): Promise<void> {
	return invoke("set_gpu_acceleration", { enabled });
}

export async function getGpuAcceleration(): Promise<boolean> {
	return invoke("get_gpu_acceleration");
}
