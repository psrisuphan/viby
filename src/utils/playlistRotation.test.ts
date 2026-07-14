import { describe, expect, it } from "vitest";
import { shouldRotatePlaylistArtwork } from "./playlistRotation";

describe("shouldRotatePlaylistArtwork", () => {
	it("only rotates multiple covers in an active window with effects enabled", () => {
		expect(shouldRotatePlaylistArtwork(2, true, false)).toBe(true);
		expect(shouldRotatePlaylistArtwork(1, true, false)).toBe(false);
		expect(shouldRotatePlaylistArtwork(2, false, false)).toBe(false);
		expect(shouldRotatePlaylistArtwork(2, true, true)).toBe(false);
	});
});
