import { beforeEach, describe, expect, it } from "vitest";
import type { PlaybackState, Track } from "../types";
import {
	comparePlaybackCursor,
	PlaybackSyncOrder,
	QueueSnapshotOrder,
} from "./playbackSyncOrder";

describe("playback cursor comparison", () => {
	it("orders generations before sequences and treats equal cursors as equal", () => {
		expect(comparePlaybackCursor(
			{ generation: 2, sequence: 99 },
			{ generation: 3, sequence: 1 },
		)).toBe(-1);
		expect(comparePlaybackCursor(
			{ generation: 3, sequence: 1 },
			{ generation: 3, sequence: 2 },
		)).toBe(-1);
		expect(comparePlaybackCursor(
			{ generation: 3, sequence: 2 },
			{ generation: 3, sequence: 2 },
		)).toBe(0);
	});
});

function snapshot(
	generation: number,
	sequence: number,
	volume: number,
	isPlaying = false,
	trackId: string | null = null,
): PlaybackState {
	return {
		is_playing: isPlaying,
		current_track: trackId
			? {
					id: trackId,
					title: trackId,
					artist: "Artist",
					album: "Album",
					album_artist: "Artist",
					genre: "Genre",
					year: null,
					track_number: null,
					disc_number: null,
					duration_secs: 180,
					file_path: `/music/${trackId}.mp3`,
					file_size: 0,
					date_added: "2024-01-01T00:00:00Z",
				} satisfies Track
			: null,
		position_secs: sequence,
		duration_secs: 180,
		volume,
		is_muted: false,
		previous_volume: volume,
		shuffle: false,
		repeat_mode: "off",
		progress_generation: generation,
		progress_sequence: sequence,
	};
}

describe("usePlayerSync snapshot ordering", () => {
	let order: PlaybackSyncOrder;

	beforeEach(() => {
		order = new PlaybackSyncOrder();
	});

	it("keeps newer progress while accepting controls from a reordered full snapshot", () => {
		const progressAccepted = order.acceptProgress({
			position_secs: 42,
			duration_secs: 180,
			generation: 2,
			sequence: 12,
		});
		const queued = order.queuePlaybackSnapshot(snapshot(2, 11, 0.4, true, "current-track"));

		expect(progressAccepted).toBe(true);
		expect(queued.progressAccepted).toBe(false);
		expect(queued.controlsAccepted).toBe(true);
		expect(order.takePendingSnapshot()).toMatchObject({
			volume: 0.4,
			is_playing: true,
			current_track: { id: "current-track" },
		});
	});

	it("applies an initial track snapshot after a newer same-generation progress tick", () => {
		order.acceptProgress({
			position_secs: 42,
			duration_secs: 180,
			generation: 2,
			sequence: 12,
		});

		const initial = order.applyInitialSnapshot(snapshot(2, 11, 0.4, true, "current-track"));

		expect(initial).toEqual({ progressAccepted: false, controlsAccepted: true });
	});

	it("invalidates a queued event when a newer resume snapshot arrives before RAF", () => {
		order.queuePlaybackSnapshot(snapshot(3, 4, 0.3));
		const initial = order.applyInitialSnapshot(snapshot(3, 5, 0.7));

		expect(initial.controlsAccepted).toBe(true);
		expect(order.takePendingSnapshot()).toBeNull();
	});

	it("drops pending controls when progress advances to a newer generation before RAF", () => {
		const queued = order.queuePlaybackSnapshot(snapshot(1, 10, 0.2));
		expect(queued.controlsAccepted).toBe(true);

		order.acceptProgress({
			position_secs: 0,
			duration_secs: 240,
			generation: 2,
			sequence: 1,
		});

		expect(order.takePendingSnapshot()).toBeNull();
	});

	it("does not apply an older initial response over a newer pending event", () => {
		order.queuePlaybackSnapshot(snapshot(4, 8, 0.2));
		const initial = order.applyInitialSnapshot(snapshot(4, 7, 0.9));

		expect(initial.controlsAccepted).toBe(false);
		expect(order.takePendingSnapshot()?.volume).toBe(0.2);
	});

	it("accepts new track and seek generations and rejects the prior generation", () => {
		order.acceptProgress({ position_secs: 179, duration_secs: 180, generation: 7, sequence: 88 });
		expect(order.acceptProgress({ position_secs: 0, duration_secs: 240, generation: 8, sequence: 1 })).toBe(true);
		expect(order.acceptProgress({ position_secs: 180, duration_secs: 180, generation: 7, sequence: 99 })).toBe(false);
	});

	it("does not apply a delayed snapshot from the previous track or seek generation", () => {
		const trackOrder = new PlaybackSyncOrder();
		trackOrder.acceptProgress({ position_secs: 0, duration_secs: 240, generation: 8, sequence: 1 });
		const previousTrack = trackOrder.queuePlaybackSnapshot(snapshot(7, 99, 0.2, true, "old-track"));
		expect(previousTrack.progressAccepted).toBe(false);
		expect(previousTrack.controlsAccepted).toBe(false);
		const changedTrack = trackOrder.queuePlaybackSnapshot(snapshot(8, 2, 0.5, true, "new-track"));
		expect(changedTrack.controlsAccepted).toBe(true);
		expect(trackOrder.takePendingSnapshot()?.current_track?.id).toBe("new-track");

		const seekOrder = new PlaybackSyncOrder();
		seekOrder.acceptProgress({ position_secs: 45, duration_secs: 180, generation: 5, sequence: 1 });
		const beforeSeek = seekOrder.applyInitialSnapshot(snapshot(4, 99, 0.9));
		expect(beforeSeek.progressAccepted).toBe(false);
		expect(beforeSeek.controlsAccepted).toBe(false);
	});

	it("resets progress on stop and rejects a delayed tick from the stopped track", () => {
		order.applyInitialSnapshot(snapshot(6, 20, 0.4, true));
		const stopped = { ...snapshot(7, 21, 0.4), position_secs: 0 };
		const result = order.queuePlaybackSnapshot(stopped);

		expect(result).toEqual({ progressAccepted: true, controlsAccepted: true });
		expect(order.takePendingSnapshot()).toMatchObject({
			is_playing: false,
			current_track: null,
			position_secs: 0,
			progress_generation: 7,
		});
		expect(order.acceptProgress({
			position_secs: 180,
			duration_secs: 180,
			generation: 6,
			sequence: 99,
		})).toBe(false);
	});

	it("lets each window refresh its own playback ordering cursor", () => {
		const windows = [new PlaybackSyncOrder(), new PlaybackSyncOrder()];
		const initial = snapshot(10, 1, 0.5, true);

		for (const windowOrder of windows) {
			expect(windowOrder.applyInitialSnapshot(initial).controlsAccepted).toBe(true);
			expect(windowOrder.acceptProgress({
				position_secs: 2,
				duration_secs: 180,
				generation: 10,
				sequence: 2,
			})).toBe(true);
			expect(windowOrder.acceptProgress({
				position_secs: 1,
				duration_secs: 180,
				generation: 9,
				sequence: 99,
			})).toBe(false);
		}
	});

	it("applies a pause control even when its embedded position trails a progress tick", () => {
		order.applyInitialSnapshot(snapshot(9, 10, 0.6, true));
		order.acceptProgress({ position_secs: 42, duration_secs: 180, generation: 9, sequence: 13 });
		const paused = order.queuePlaybackSnapshot(snapshot(9, 12, 0.6, false));

		expect(paused.progressAccepted).toBe(false);
		expect(paused.controlsAccepted).toBe(true);
		expect(order.takePendingSnapshot()?.is_playing).toBe(false);
	});
});

describe("QueueSnapshotOrder", () => {
	it("rejects a pull after a queue or position event arrives", () => {
		const order = new QueueSnapshotOrder();
		const request = order.beginRequest();

		order.noteQueueUpdate();

		expect(order.canApply(request)).toBe(false);
	});

	it("accepts only the newest overlapping request", () => {
		const order = new QueueSnapshotOrder();
		const older = order.beginRequest();
		const newer = order.beginRequest();

		expect(order.canApply(older)).toBe(false);
		expect(order.canApply(newer)).toBe(true);
	});
});
