// ============================================
// Viby — Tauri IPC Helpers
// Wrappers for communicating with the Rust backend
// ============================================

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { commands, events } from "../bindings";
import type {
	Track,
	Album,
	Artist,
	Playlist,
	PlaybackState,
	PlaybackProgressPayload,
	SearchResults,
	ScanProgress,
	ScanPayload,
	QueuePayload,
	QueuePositionPayload,
	TopArtist,
	TrackEqOverride,
	NormalizationAnalysisStatus,
	RepeatMode,
	TargetCurve,
	PeqBandParam,
	ArtworkPayload,
	BackgroundAppStatus,
	NativeWindowTheme,
	AutoEqResult,
} from "../types";
import type { PlaybackPreferences } from "./playerPreferences";
import { useSettingsStore, type PeqBand } from "../stores/settingsStore";

export type { TargetCurve } from "../types";

const discardResult = <T>(promise: Promise<T>): Promise<void> =>
	promise.then(() => undefined);

// ── Playback Commands ──

export async function playTrack(trackId: string): Promise<void> {
	return discardResult(commands.playTrack(trackId));
}

export async function pausePlayback(): Promise<void> {
	return commands.pause();
}

export async function resumePlayback(): Promise<void> {
	return commands.resume();
}

export async function stopPlayback(): Promise<void> {
	return commands.stop();
}

export async function setSoundCheckEnabled(enabled: boolean): Promise<void> {
	return commands.setSoundCheckEnabled(enabled);
}

export async function setSoundCheckTargetLufs(targetLufs: number): Promise<void> {
	return commands.setSoundCheckTargetLufs(targetLufs);
}

export async function analyzeMissingNormalization(): Promise<NormalizationAnalysisStatus> {
	return commands.analyzeMissingNormalization();
}

export async function seekTo(positionSecs: number): Promise<void> {
	return commands.seek(positionSecs);
}

const VOLUME_FLUSH_INTERVAL_MS = 50;
let pendingBackendVolume: number | null = null;
let volumeFlushTimer: ReturnType<typeof setTimeout> | null = null;
let volumeFlushInFlight: Promise<void> | null = null;
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
	if (volumeFlushTimer !== null || volumeFlushInFlight !== null) return;
	volumeFlushTimer = setTimeout(() => {
		volumeFlushTimer = null;
		void flushPendingVolume().catch(() => {});
	}, delayMs);
}

async function flushPendingVolume(): Promise<void> {
	clearVolumeFlushTimer();
	if (volumeFlushInFlight !== null) await volumeFlushInFlight;
	const volume = pendingBackendVolume;
	if (volume === null) return;

	const resolvers = volumeFlushResolvers;
	volumeFlushResolvers = [];
	pendingBackendVolume = null;

	const operation = (async () => {
		if (playbackDebugEnabled()) {
			console.info("[VibyDebug] flushed backend volume", { volume });
		}
		await commands.setVolume(volume);
		resolvers.forEach(({ resolve }) => resolve());
	})();
	volumeFlushInFlight = operation.catch((error) => {
		resolvers.forEach(({ reject }) => reject(error));
		throw error;
	});
	const inFlight = volumeFlushInFlight;
	let failed = false;
	let failure: unknown;
	try {
		await inFlight;
	} catch (error) {
		failed = true;
		failure = error;
	} finally {
		if (volumeFlushInFlight === inFlight) volumeFlushInFlight = null;
	}
	if (pendingBackendVolume !== null) {
		if (failed) scheduleVolumeFlush(VOLUME_FLUSH_INTERVAL_MS);
		else await flushPendingVolume();
	}
	if (failed) throw failure;
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
		void flushPendingVolume().catch(() => {});
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
	return discardResult(commands.setEq(enabled, preamp, gains));
}

export async function getTrackEqOverride(
	trackId: string,
): Promise<TrackEqOverride | null> {
	return commands.getTrackEqOverride(trackId);
}

export async function saveTrackEqOverride(
	trackId: string,
	enabled: boolean,
	preampDb: number,
	gains: number[],
): Promise<TrackEqOverride> {
	return commands.saveTrackEqOverride(trackId, enabled, preampDb, gains);
}

export async function previewTrackEqOverride(
	enabled: boolean,
	preampDb: number,
	gains: number[],
): Promise<void> {
	return discardResult(commands.previewTrackEqOverride(enabled, preampDb, gains));
}

export async function clearTrackEqOverride(): Promise<void> {
	return commands.clearTrackEqOverride();
}

export async function deleteTrackEqOverride(trackId: string): Promise<void> {
	return discardResult(commands.deleteTrackEqOverride(trackId));
}

export async function setPeq(
	enabled: boolean,
	preamp: number,
	bands: PeqBandParam[],
): Promise<void> {
	return discardResult(commands.setPeq(enabled, preamp, bands));
}

export async function getTargetCurves(): Promise<TargetCurve[]> {
	return commands.getTargetCurves();
}

export async function importTargetCurve(): Promise<TargetCurve | null> {
	return commands.importTargetCurve();
}

export async function deleteTargetCurve(name: string): Promise<void> {
	return discardResult(commands.deleteTargetCurve(name));
}

export async function getHeadphoneMeasurements(): Promise<TargetCurve[]> {
	return commands.getHeadphoneMeasurements();
}

export async function importHeadphoneMeasurement(): Promise<TargetCurve | null> {
	return commands.importHeadphoneMeasurement();
}

export async function addHeadphoneMeasurement(
	name: string,
	points: [number, number][],
): Promise<TargetCurve> {
	return commands.addHeadphoneMeasurement(name, points);
}

export async function deleteHeadphoneMeasurement(name: string): Promise<void> {
	return discardResult(commands.deleteHeadphoneMeasurement(name));
}

export async function pickEqFilterFile(): Promise<{
	name: string;
	content: string;
} | null> {
	return commands.pickEqFilterFile();
}

export async function getPlaybackState(): Promise<PlaybackState> {
	return commands.getPlaybackState();
}

export async function frontendReady(): Promise<void> {
	return commands.frontendReady();
}

export async function setFrontendVisible(visible: boolean): Promise<void> {
	return commands.setFrontendVisible(visible);
}

export async function setMainWebviewFocus(): Promise<void> {
	return invoke("plugin:webview|set_webview_focus", { label: "main" });
}

export async function exitApp(): Promise<void> {
	return commands.exitApp();
}

export async function setRendererSuspensionEnabled(enabled: boolean): Promise<void> {
	return commands.setRendererSuspensionEnabled(enabled);
}

export async function setDiscordRpcEnabled(enabled: boolean): Promise<void> {
	return commands.setDiscordRpcEnabled(enabled);
}

export async function setDiscordRpcQualityEnabled(enabled: boolean): Promise<void> {
	return commands.setDiscordRpcQualityEnabled(enabled);
}

export async function getBackgroundAppStatus(): Promise<BackgroundAppStatus> {
	return commands.getBackgroundAppStatus();
}

export async function requestBackgroundApp(): Promise<BackgroundAppStatus> {
	return commands.requestBackgroundApp();
}

export async function setBackgroundAppEnabled(
	enabled: boolean,
): Promise<BackgroundAppStatus> {
	return commands.setBackgroundAppEnabled(enabled);
}

export async function hideToBackground(): Promise<BackgroundAppStatus> {
	return commands.hideToBackground();
}

export async function isKdeDesktop(): Promise<boolean> {
	return commands.isKdeDesktop();
}

export async function isGnomeDesktop(): Promise<boolean> {
	return commands.isGnomeDesktop();
}

export async function setNativeWindowTheme(theme: NativeWindowTheme): Promise<void> {
	return discardResult(commands.setNativeWindowTheme(theme));
}

export async function showMiniPlayer(): Promise<void> {
	return discardResult(commands.showMiniPlayer());
}

export async function leaveMiniPlayer(): Promise<void> {
	return discardResult(commands.leaveMiniPlayer());
}

export async function showTheaterMode(): Promise<void> {
	return discardResult(commands.showTheaterMode());
}

export async function leaveTheaterMode(): Promise<void> {
	return discardResult(commands.leaveTheaterMode());
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
          await commands.skipTracks(skipDelta, true);
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
  await commands.nextTrack(userInitiated);
}

export async function previousTrack(userInitiated: boolean): Promise<void> {
  if (userInitiated) {
    await scheduleSkip(-1);
    return;
  }
  await commands.previousTrack(userInitiated);
}

export async function setShuffle(enabled: boolean): Promise<void> {
	return discardResult(commands.setShuffle(enabled));
}

export async function setRepeat(mode: RepeatMode): Promise<void> {
	return discardResult(commands.setRepeat(mode));
}

export async function toggleMutePlayback(): Promise<void> {
	await flushPendingVolume();
	return invoke("toggle_mute");
}

export async function initializePlaybackPreferences(
	legacy: PlaybackPreferences | null,
): Promise<void> {
	return invoke("initialize_playback_preferences", { legacy });
}

export async function refreshPlaybackMetadata(): Promise<void> {
	return invoke("refresh_playback_metadata");
}

export async function toggleShufflePlayback(): Promise<void> {
	return invoke("toggle_shuffle");
}

export async function cycleRepeatPlayback(): Promise<void> {
	return invoke("cycle_repeat");
}

// ── Queue Commands ──

export const getQueue = async (): Promise<QueuePayload> => {
	return commands.getQueue();
};

export const addToQueue = async (trackId: string): Promise<void> => {
	await commands.addToQueue(trackId);
};

export const addToQueueNext = async (trackId: string): Promise<void> => {
	await commands.addToQueueNext(trackId);
};

export const addTracksToQueue = async (trackIds: string[]): Promise<void> => {
	await commands.addTracksToQueue(trackIds);
};

export const addTracksToQueueNext = async (trackIds: string[]): Promise<void> => {
	await commands.addTracksToQueueNext(trackIds);
};

export const playTracks = async (
	trackIds: string[],
	startIndex: number,
	shuffle: boolean,
): Promise<void> => {
	await commands.playTracks(trackIds, startIndex, shuffle);
};

export const removeFromQueue = async (index: number): Promise<void> => {
	await commands.removeFromQueue(index);
};

export const reorderQueue = async (
	oldIndex: number,
	newIndex: number,
): Promise<void> => {
	await commands.reorderQueue(oldIndex, newIndex);
};

export const clearQueue = async (): Promise<void> => {
	await commands.clearAll();
};

export const clearUpNext = async (): Promise<void> => {
	await commands.clearUpNext();
};

export const clearHistory = async (): Promise<void> => {
	return discardResult(commands.clearHistory());
};

export const playQueueIndex = async (index: number): Promise<void> => {
	await commands.playQueueIndex(index);
};

// ============================================
// Playlists API
// ============================================

export const createPlaylist = async (name: string): Promise<Playlist> => {
	return commands.createPlaylist(name);
};

export const deletePlaylist = async (id: string): Promise<void> => {
	await commands.deletePlaylist(id);
};

export const renamePlaylist = async (
	id: string,
	name: string,
): Promise<void> => {
	await commands.renamePlaylist(id, name);
};

export const getPlaylists = async (): Promise<Playlist[]> => {
	return commands.getPlaylists();
};

export const getPlaylistTracks = async (
	playlistId: string,
): Promise<Track[]> => {
	return commands.getPlaylistTracks(playlistId);
};

export const addToPlaylist = async (
	playlistId: string,
	trackIds: string[],
): Promise<void> => {
	await commands.addToPlaylist(playlistId, trackIds);
};

export const removeFromPlaylist = async (
	playlistId: string,
	trackId: string,
): Promise<void> => {
	await commands.removeFromPlaylist(playlistId, trackId);
};

export const reorderPlaylist = async (
	playlistId: string,
	trackIds: string[],
): Promise<void> => {
	await commands.reorderPlaylist(playlistId, trackIds);
};

// ── Library Commands ──

export async function getLibraryFolders(): Promise<string[]> {
	return commands.getLibraryFolders();
}

export async function pickLibraryFolders(): Promise<string[]> {
	return commands.pickLibraryFolders();
}

export async function removeLibraryFolder(path: string): Promise<void> {
	return discardResult(commands.removeLibraryFolder(path));
}

export async function scanLibrary(): Promise<ScanPayload> {
	return commands.scanLibrary();
}

export async function getAllTracks(): Promise<Track[]> {
	return commands.getAllTracks();
}

export async function getAlbumTracks(
	album: string,
	albumArtist: string,
): Promise<Track[]> {
	return commands.getAlbumTracks(album, albumArtist);
}

export async function getAlbums(): Promise<Album[]> {
	return commands.getAlbums();
}

export async function getArtists(): Promise<Artist[]> {
	return commands.getArtists();
}

export async function getGenres(): Promise<string[]> {
	return commands.getGenres();
}

export async function clearPlayHistory(): Promise<void> {
	return discardResult(commands.clearPlayHistory());
}

export async function clearBackendArtworkCache(): Promise<void> {
	return discardResult(commands.clearArtworkCache());
}

export async function getRecentlyPlayed(): Promise<Track[]> {
	return commands.getRecentlyPlayed();
}

export async function getTopArtistsPlayed(): Promise<TopArtist[]> {
	return commands.getTopArtistsPlayed();
}

export async function getRecentlyAddedTracks(): Promise<Track[]> {
	return commands.getRecentlyAddedTracks();
}

export async function searchLibrary(query: string): Promise<SearchResults> {
	return commands.search(query);
}

export async function getTrackArtwork(
	trackId: string,
	size: 128 | 384 | 768 = 384,
): Promise<ArtworkPayload | null> {
	return commands.getTrackArtwork(trackId, size);
}

// ── Event Listeners ──

/** Listen for playback state changes (play/pause/stop) */
export function onPlaybackStateChange(
	callback: (state: PlaybackState) => void,
): Promise<UnlistenFn> {
	return events.playbackState.listen((event) => {
		callback(event.payload);
	});
}

export function onPlaybackProgressChange(
	callback: (progress: PlaybackProgressPayload) => void,
): Promise<UnlistenFn> {
	return listen<PlaybackProgressPayload>("playback-progress", (event) => {
		callback(event.payload);
	});
}

/** Listen for library scan progress */
export function onScanProgress(
	callback: (progress: ScanProgress) => void,
): Promise<UnlistenFn> {
	return events.scanProgress.listen((event) => {
		callback(event.payload);
	});
}

/** Listen for queue updates */
export function onQueueChanged(
	callback: (payload: QueuePayload) => void,
): Promise<UnlistenFn> {
	return events.queueChanged.listen((event) => {
		callback(event.payload);
	});
}

/** Listen for lightweight queue cursor updates */
export function onQueuePositionChanged(
	callback: (payload: QueuePositionPayload) => void,
): Promise<UnlistenFn> {
	return events.queuePositionChanged.listen((event) => {
		callback(event.payload);
	});
}

export async function runAutoEqBackend(
	measurement: TargetCurve,
	target: TargetCurve,
	bandsToOptimize: PeqBand[],
	options: {
		config?: "standard" | "precise";
		smooth?: "ie" | "oe" | "none";
		steps?: number;
		sampleRate?: number;
	} = {},
): Promise<Omit<AutoEqResult, "bands"> & { bands: PeqBand[] }> {
	const result = await commands.runAutoeq(
		measurement,
		target,
		bandsToOptimize,
		{
			config: options.config ?? "standard",
			smooth: options.smooth ?? "none",
			steps: options.steps ?? 3000,
			sampleRate: 48000,
			...options,
		},
	);
	const bands = result.bands.map((band) => {
		if (!Number.isInteger(band.filterType) || band.filterType < 0 || band.filterType > 4) {
			throw new Error(`Unsupported AutoEQ filter type: ${band.filterType}`);
		}
		return { ...band, filterType: band.filterType as PeqBand["filterType"] };
	});
	return { ...result, bands };
}

export async function calculateEqResponseBackend(request: {
	mode: "graphic" | "parametric";
	enabled: boolean;
	preamp: number;
	gains?: number[];
	bands?: PeqBandParam[];
	frequencies: number[];
	sampleRate?: number;
}): Promise<number[]> {
	const response = await commands.calculateEqResponse({
		mode: request.mode,
		enabled: request.enabled,
		preamp: request.preamp,
		gains: request.gains ?? null,
		bands: request.bands ?? null,
		frequencies: request.frequencies,
		sampleRate: request.sampleRate ?? null,
	});
	return response.map((value) => value ?? 0);
}

export async function setGpuAcceleration(enabled: boolean): Promise<void> {
	return discardResult(commands.setGpuAcceleration(enabled));
}

export async function getGpuAcceleration(): Promise<boolean> {
	return commands.getGpuAcceleration();
}
