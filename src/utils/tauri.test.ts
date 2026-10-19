import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	invoke: vi.fn(),
	listen: vi.fn(async () => () => undefined),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
	listen: mocks.listen,
	once: vi.fn(),
	emit: vi.fn(),
}));

import {
	addToQueue,
	addToQueueNext,
	addTracksToQueue,
	addTracksToQueueNext,
	cycleRepeatPlayback,
	initializePlaybackPreferences,
	onPlaybackProgressChange,
	playTracks,
	refreshPlaybackMetadata,
	revealTrackInFolder,
	toggleMutePlayback,
	toggleShufflePlayback,
} from "./tauri";

describe("queue command IPC contracts", () => {
	beforeEach(() => mocks.invoke.mockReset().mockResolvedValue(null));

	it("sends one track ID for single-track commands", async () => {
		await addToQueue("track-1");
		expect(mocks.invoke).toHaveBeenLastCalledWith("add_to_queue", {
			trackId: "track-1",
		});

		await addToQueueNext("track-2");
		expect(mocks.invoke).toHaveBeenLastCalledWith("add_to_queue_next", {
			trackId: "track-2",
		});
	});

	it("sends ordered track ID lists for batch commands", async () => {
		const trackIds = ["track-2", "track-1"];

		await addTracksToQueue(trackIds);
		expect(mocks.invoke).toHaveBeenLastCalledWith("add_tracks_to_queue", {
			trackIds,
		});

		await addTracksToQueueNext(trackIds);
		expect(mocks.invoke).toHaveBeenLastCalledWith("add_tracks_to_queue_next", {
			trackIds,
		});
	});

	it("sends the ordered IDs, zero-based start index, and shuffle mode atomically", async () => {
		const trackIds = ["track-3", "track-1", "track-2"];

		await playTracks(trackIds, 1, true);

		expect(mocks.invoke).toHaveBeenLastCalledWith("play_tracks", {
			trackIds,
			startIndex: 1,
			shuffle: true,
		});
	});
});

describe("playback IPC contracts", () => {
	beforeEach(() => {
		mocks.invoke.mockReset().mockResolvedValue(null);
		mocks.listen.mockClear();
	});

	it("routes preference, metadata, and playback mode commands through generated bindings", async () => {
		const legacy = {
			volume: 0.3,
			isMuted: true,
			previousVolume: 0.5,
			shuffle: true,
			repeatMode: "all" as const,
		};

		await toggleMutePlayback();
		expect(mocks.invoke).toHaveBeenLastCalledWith("toggle_mute");

		await initializePlaybackPreferences(legacy);
		expect(mocks.invoke).toHaveBeenLastCalledWith("initialize_playback_preferences", { legacy });

		await refreshPlaybackMetadata();
		expect(mocks.invoke).toHaveBeenLastCalledWith("refresh_playback_metadata");

		await toggleShufflePlayback();
		expect(mocks.invoke).toHaveBeenLastCalledWith("toggle_shuffle");

		await cycleRepeatPlayback();
		expect(mocks.invoke).toHaveBeenLastCalledWith("cycle_repeat");
	});

	it("registers playback progress through the generated event contract", async () => {
		const unlisten = await onPlaybackProgressChange(() => {});

		expect(mocks.listen).toHaveBeenCalledWith("playback-progress", expect.any(Function));
		expect(unlisten).toEqual(expect.any(Function));
	});
});

describe("file reveal command IPC contract", () => {
	beforeEach(() => mocks.invoke.mockReset());

	it("sends the database track ID instead of a frontend path", async () => {
		await revealTrackInFolder("track-42");
		expect(mocks.invoke).toHaveBeenCalledWith("reveal_track_in_folder", {
			trackId: "track-42",
		});
	});
});
