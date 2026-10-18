import { describe, expect, it } from "vitest";
import {
	getSongRowKeyAction,
	getSelectedTracksInVisibleOrder,
	updateSongSelection,
} from "./songSelection";

const tracks = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const none = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };

describe("song selection", () => {
	it("maps row arrows, Enter and Space to the expected keyboard actions", () => {
		expect(getSongRowKeyAction("ArrowDown", true, 2, false, none)).toEqual({
			type: "move-focus",
			index: 3,
		});
		expect(getSongRowKeyAction("ArrowUp", true, 2, false, none)).toEqual({
			type: "move-focus",
			index: 1,
		});
		expect(getSongRowKeyAction("Enter", true, 2, false, none)).toEqual({
			type: "play",
		});
		expect(getSongRowKeyAction(" ", true, 2, false, none)).toEqual({
			type: "select",
			checked: true,
			modifiers: none,
		});
		expect(
			getSongRowKeyAction(" ", true, 2, true, { ...none, shiftKey: true }),
		).toEqual({
			type: "select",
			checked: true,
			modifiers: { ...none, shiftKey: true },
		});
		expect(getSongRowKeyAction("Enter", false, 2, false, none)).toBeNull();
		expect(getSongRowKeyAction(" ", false, 2, false, none)).toBeNull();
		expect(getSongRowKeyAction("ArrowDown", false, 2, false, none)).toBeNull();
	});

	it("does not move song-row focus for modified arrows", () => {
		for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"] as const) {
			expect(
				getSongRowKeyAction("ArrowDown", true, 2, false, {
					...none,
					[modifier]: true,
				}),
			).toBeNull();
		}
	});

	it("selects a shift range in the current filtered order", () => {
		const filteredAndSorted = [tracks[3], tracks[1], tracks[0]];
		const first = updateSongSelection(
			new Set(), filteredAndSorted, "d", true, null, none,
		);
		const range = updateSongSelection(
			first.selectedIds,
			filteredAndSorted,
			"a",
			true,
			first.anchorTrackId,
			{ ...none, shiftKey: true },
		);

		expect([...range.selectedIds]).toEqual(["d", "b", "a"]);
		expect(getSelectedTracksInVisibleOrder(filteredAndSorted, range.selectedIds))
			.toEqual(filteredAndSorted);
	});

	it("adds and toggles individual tracks without losing other selections", () => {
		const selected = new Set(["a", "c"]);
		const add = updateSongSelection(selected, tracks, "b", true, "a", none);
		const remove = updateSongSelection(
			add.selectedIds, tracks, "c", false, add.anchorTrackId, none,
		);

		expect([...add.selectedIds]).toEqual(["a", "c", "b"]);
		expect(remove.selectedIds).toEqual(new Set(["a", "b"]));
	});

	it("keeps an additive shift range anchored to the original selection", () => {
		const result = updateSongSelection(
			new Set(["a"]),
			tracks,
			"c",
			true,
			"a",
			{ ...none, shiftKey: true, ctrlKey: true },
		);

		expect(result.selectedIds).toEqual(new Set(["a", "b", "c"]));
		expect(result.anchorTrackId).toBe("a");
	});
});
