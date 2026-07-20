import { describe, expect, it } from "vitest";
import { findTrackAlbum } from "./findTrackAlbum";
import type { Album, Track } from "../types";

const track = {
	album: "Album",
	album_artist: "Album Artist",
	artist: "Track Artist",
} as Track;

const album = (artist: string): Album => ({
	name: "Album",
	artist,
	year: null,
	track_count: 1,
	artwork_track_id: null,
});

describe("findTrackAlbum", () => {
	it("prefers the album artist and falls back to track artist or album name", () => {
		expect(findTrackAlbum([album("Track Artist"), album("Album Artist")], track)?.artist).toBe("Album Artist");
		expect(findTrackAlbum([album("Track Artist")], track)?.artist).toBe("Track Artist");
		expect(findTrackAlbum([album("Other Artist")], track)?.artist).toBe("Other Artist");
	});
});
