// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerSync } from "./usePlayerSync";
import { usePlayerStore } from "../stores/playerStore";
import { usePlaybackProgressStore } from "../stores/playbackProgressStore";
import { useQueueStore } from "../stores/queueStore";
import type { PlaybackState, QueuePayload } from "../types";

const ipc = vi.hoisted(() => ({
	playbackStateListeners: [] as Array<(payload: unknown) => void>,
	playbackProgressListeners: [] as Array<(payload: unknown) => void>,
	queueChangedListeners: [] as Array<(payload: unknown) => void>,
	queuePositionListeners: [] as Array<(payload: unknown) => void>,
	getPlaybackState: vi.fn(),
	getQueue: vi.fn(),
}));

vi.mock("../utils/tauri", () => ({
	getPlaybackState: ipc.getPlaybackState,
	getQueue: ipc.getQueue,
	onPlaybackStateChange: (callback: (payload: unknown) => void) => {
		ipc.playbackStateListeners.push(callback);
		return Promise.resolve(() => {});
	},
	onPlaybackProgressChange: (callback: (payload: unknown) => void) => {
		ipc.playbackProgressListeners.push(callback);
		return Promise.resolve(() => {});
	},
	onQueueChanged: (callback: (payload: unknown) => void) => {
		ipc.queueChangedListeners.push(callback);
		return Promise.resolve(() => {});
	},
	onQueuePositionChanged: (callback: (payload: unknown) => void) => {
		ipc.queuePositionListeners.push(callback);
		return Promise.resolve(() => {});
	},
}));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function playbackSnapshot(sequence: number, volume: number): PlaybackState {
	return {
		is_playing: false,
		current_track: null,
		position_secs: sequence,
		duration_secs: 180,
		progress_generation: 1,
		progress_sequence: sequence,
		volume,
		is_muted: false,
		previous_volume: volume,
		shuffle: false,
		repeat_mode: "off",
	};
}

function playbackTrack(id: string): NonNullable<PlaybackState["current_track"]> {
	return {
		id,
		title: id,
		artist: "Artist",
		album: "Album",
		album_artist: "Artist",
		genre: "Genre",
		year: null,
		track_number: null,
		disc_number: null,
		duration_secs: 180,
		file_path: `/music/${id}.mp3`,
		file_size: 0,
		date_added: "2024-01-01T00:00:00Z",
	};
}

function queueSnapshot(currentIndex: number | null): QueuePayload {
	return { tracks: [], current_index: currentIndex };
}

function emit<T>(listeners: Array<(payload: unknown) => void>, payload: T) {
	for (const listener of listeners) listener(payload);
}

describe("usePlayerSync queue snapshot races", () => {
	let rafCallbacks: FrameRequestCallback[];

	beforeEach(() => {
		ipc.getPlaybackState.mockClear();
		ipc.getQueue.mockClear();
		ipc.playbackStateListeners.length = 0;
		ipc.playbackProgressListeners.length = 0;
		ipc.queueChangedListeners.length = 0;
		ipc.queuePositionListeners.length = 0;
		ipc.getPlaybackState.mockResolvedValue(playbackSnapshot(1, 0.5));
		ipc.getQueue.mockResolvedValue(queueSnapshot(0));
		rafCallbacks = [];
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			rafCallbacks.push(callback);
			return rafCallbacks.length;
		});
		vi.stubGlobal("cancelAnimationFrame", vi.fn());
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			value: "visible",
		});
		vi.spyOn(console, "info").mockImplementation(() => {});
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		usePlayerStore.setState({ volume: 1 });
		usePlaybackProgressStore.setState({
			positionSecs: 0,
			durationSecs: 0,
			generation: 0,
			sequence: 0,
			seekPercent: null,
		});
		useQueueStore.setState({ tracks: [], currentIndex: null });
	});

	it("keeps live queue and playback events when the initial IPC snapshot resolves late", async () => {
		const playback = deferred<PlaybackState>();
		const queue = deferred<QueuePayload>();
		ipc.getPlaybackState.mockReturnValue(playback.promise);
		ipc.getQueue.mockReturnValue(queue.promise);

		renderHook(() => usePlayerSync());
		await waitFor(() => expect(ipc.getQueue).toHaveBeenCalledTimes(1));

		act(() => emit(ipc.queueChangedListeners, queueSnapshot(7)));
		act(() => emit(ipc.playbackStateListeners, playbackSnapshot(2, 0.8)));
		expect(rafCallbacks).toHaveLength(1);
		act(() => rafCallbacks.shift()?.(0));
		expect(usePlayerStore.getState().volume).toBe(0.8);

		await act(async () => {
			playback.resolve(playbackSnapshot(1, 0.2));
			queue.resolve(queueSnapshot(1));
			await Promise.all([playback.promise, queue.promise]);
		});

		expect(useQueueStore.getState().currentIndex).toBe(7);
		expect(usePlayerStore.getState().volume).toBe(0.8);
	});

	it("ignores an older overlapping resume pull after the newer pull applies", async () => {
		const queueResponses: Array<ReturnType<typeof deferred<QueuePayload>>> = [];
		let playbackRequestCount = 0;
		ipc.getQueue.mockImplementation(() => {
			const response = deferred<QueuePayload>();
			queueResponses.push(response);
			return response.promise;
		});
		ipc.getPlaybackState.mockImplementation(() =>
			Promise.resolve(playbackSnapshot(++playbackRequestCount, 0.5)),
		);

		renderHook(() => usePlayerSync());
		await waitFor(() => expect(ipc.getQueue).toHaveBeenCalledTimes(1));
		window.dispatchEvent(new Event("focus"));
		await waitFor(() => expect(queueResponses.length).toBeGreaterThan(1));
		const newestRequest = queueResponses[queueResponses.length - 1];
		expect(newestRequest).toBeDefined();

		await act(async () => {
			newestRequest?.resolve(queueSnapshot(2));
			await newestRequest?.promise;
		});
		await waitFor(() =>
			expect(useQueueStore.getState().currentIndex).toBe(2),
		);

		await act(async () => {
			for (const olderRequest of queueResponses.slice(0, -1)) {
				olderRequest.resolve(queueSnapshot(1));
			}
			await Promise.all(
				queueResponses.slice(0, -1).map((request) => request.promise),
			);
		});

		expect(useQueueStore.getState().currentIndex).toBe(2);
	});

	it("initializes independent windows and deduplicates matching state/progress events", async () => {
		renderHook(() => usePlayerSync());
		renderHook(() => usePlayerSync());
		await waitFor(() => {
			expect(ipc.getPlaybackState).toHaveBeenCalledTimes(2);
			expect(ipc.playbackStateListeners).toHaveLength(2);
			expect(ipc.playbackProgressListeners).toHaveLength(2);
			expect(usePlaybackProgressStore.getState().sequence).toBe(1);
		});

		let progressNotifications = 0;
		const unsubscribe = usePlaybackProgressStore.subscribe(() => progressNotifications++);
		const current = {
			...playbackSnapshot(2, 0.5),
			progress_generation: 2,
			progress_sequence: 2,
		};
		const matchingProgress = {
			position_secs: current.position_secs,
			duration_secs: current.duration_secs,
			generation: current.progress_generation,
			sequence: current.progress_sequence,
		};

		act(() => {
			emit(ipc.playbackStateListeners, current);
			emit(ipc.playbackProgressListeners, matchingProgress);
		});

		expect(progressNotifications).toBe(1);
		expect(usePlaybackProgressStore.getState()).toMatchObject({
			positionSecs: 2,
			generation: 2,
			sequence: 2,
		});
		unsubscribe();
	});

	it("keeps a stop reset when a delayed progress tick from the prior track arrives", async () => {
		renderHook(() => usePlayerSync());
		await waitFor(() => {
			expect(ipc.getPlaybackState).toHaveBeenCalledTimes(1);
			expect(usePlaybackProgressStore.getState().sequence).toBe(1);
		});

		const stopped = {
			...playbackSnapshot(1, 0.5),
			is_playing: false,
			position_secs: 0,
			duration_secs: 0,
			progress_generation: 2,
			progress_sequence: 1,
		};
		act(() => {
			emit(ipc.playbackStateListeners, stopped);
			emit(ipc.playbackProgressListeners, {
				position_secs: 180,
				duration_secs: 180,
				generation: 1,
				sequence: 99,
			});
		});

		expect(usePlaybackProgressStore.getState()).toMatchObject({
			positionSecs: 0,
			durationSecs: 0,
			generation: 2,
			sequence: 1,
		});
	});

	it("drops queued prior-track controls when a newer generation arrives before RAF", async () => {
		renderHook(() => usePlayerSync());
		await waitFor(() => {
			expect(ipc.getPlaybackState).toHaveBeenCalledTimes(1);
			expect(usePlayerStore.getState().volume).toBe(0.5);
		});

		const staleControls = {
			...playbackSnapshot(2, 0.2),
			progress_generation: 1,
			progress_sequence: 2,
		};
		act(() => emit(ipc.playbackStateListeners, staleControls));
		expect(rafCallbacks).toHaveLength(1);

		act(() => emit(ipc.playbackProgressListeners, {
			position_secs: 0,
			duration_secs: 240,
			generation: 2,
			sequence: 1,
		}));
		act(() => rafCallbacks.shift()?.(0));

		expect(usePlayerStore.getState().volume).toBe(0.5);
		expect(usePlaybackProgressStore.getState()).toMatchObject({
			generation: 2,
			sequence: 1,
			positionSecs: 0,
		});
	});

	it("applies reordered same-generation track controls without rolling progress back", async () => {
		renderHook(() => usePlayerSync());
		await waitFor(() => expect(usePlaybackProgressStore.getState().sequence).toBe(1));

		act(() => emit(ipc.playbackProgressListeners, {
			position_secs: 11,
			duration_secs: 180,
			generation: 2,
			sequence: 11,
		}));
		act(() => emit(ipc.playbackStateListeners, {
			...playbackSnapshot(10, 0.4),
			is_playing: true,
			current_track: playbackTrack("reordered-track"),
			progress_generation: 2,
			progress_sequence: 10,
		}));

		expect(rafCallbacks).toHaveLength(1);
		act(() => rafCallbacks.shift()?.(0));

		expect(usePlayerStore.getState()).toMatchObject({
			isPlaying: true,
			currentTrack: { id: "reordered-track" },
			volume: 0.4,
		});
		expect(usePlaybackProgressStore.getState()).toMatchObject({
			generation: 2,
			sequence: 11,
			positionSecs: 11,
		});
	});

	it("keeps a track from the initial pull when same-generation progress arrives first", async () => {
		const playback = deferred<PlaybackState>();
		const queue = deferred<QueuePayload>();
		ipc.getPlaybackState.mockReturnValue(playback.promise);
		ipc.getQueue.mockReturnValue(queue.promise);

		renderHook(() => usePlayerSync());
		await waitFor(() => expect(ipc.getQueue).toHaveBeenCalledTimes(1));
		act(() => emit(ipc.playbackProgressListeners, {
			position_secs: 11,
			duration_secs: 180,
			generation: 2,
			sequence: 11,
		}));

		const initial = {
			...playbackSnapshot(10, 0.4),
			is_playing: true,
			current_track: playbackTrack("initial-track"),
			progress_generation: 2,
			progress_sequence: 10,
		};
		await act(async () => {
			playback.resolve(initial);
			queue.resolve(queueSnapshot(0));
			await Promise.all([playback.promise, queue.promise]);
		});

		expect(usePlayerStore.getState()).toMatchObject({
			isPlaying: true,
			currentTrack: { id: "initial-track" },
			volume: 0.4,
		});
		expect(usePlaybackProgressStore.getState()).toMatchObject({
			generation: 2,
			sequence: 11,
			positionSecs: 11,
		});
	});
});
