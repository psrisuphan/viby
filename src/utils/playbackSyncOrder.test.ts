import { beforeEach, describe, expect, it } from "vitest";
import type { PlaybackState } from "../types";
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
): PlaybackState {
	return {
		is_playing: isPlaying,
		current_track: null,
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

	it("keeps newer progress while accepting the controls from an older full snapshot", () => {
		const progressAccepted = order.acceptProgress({
			position_secs: 42,
			duration_secs: 180,
			generation: 2,
			sequence: 12,
		});
		const queued = order.queuePlaybackSnapshot(snapshot(2, 11, 0.4));

		expect(progressAccepted).toBe(true);
		expect(queued.progressAccepted).toBe(false);
		expect(queued.controlsAccepted).toBe(true);
		expect(order.takePendingSnapshot()?.volume).toBe(0.4);
	});

	it("invalidates a queued event when a newer resume snapshot arrives before RAF", () => {
		order.queuePlaybackSnapshot(snapshot(3, 4, 0.3));
		const initial = order.applyInitialSnapshot(snapshot(3, 5, 0.7));

		expect(initial.controlsAccepted).toBe(true);
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
