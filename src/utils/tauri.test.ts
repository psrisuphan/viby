import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import {
	addToQueue,
	addToQueueNext,
	addTracksToQueue,
	addTracksToQueueNext,
	revealTrackInFolder,
} from "./tauri";

describe("queue command IPC contracts", () => {
	beforeEach(() => mocks.invoke.mockReset());

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
