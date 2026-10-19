import { describe, expect, it } from "vitest";
import type { Track } from "../../types";
import { orderTracks, sortTracks } from "./sortTracks";

function makeTrack(
	id: string,
	values: Partial<Track> = {},
): Track {
	return {
		id,
		title: "Song",
		artist: "Artist",
		album: "Album",
		album_artist: "Artist",
		genre: "Unknown",
		year: null,
		track_number: null,
		disc_number: null,
		duration_secs: 180,
		file_path: `/music/${id}.flac`,
		file_size: 100,
		replaygain_track_gain: null,
		replaygain_track_peak: null,
		date_added: "2024-01-01T00:00:00Z",
		...values,
	};
}

describe("sortTracks", () => {
	it.each(["title", "artist", "album", "duration", "date_added"] as const)(
		"sorts %s naturally in ascending order",
		(field) => {
			const tracks = [
				makeTrack("10", {
					title: "Track 10",
					artist: "Artist 10",
					album: "Album 10",
					duration_secs: 310,
					date_added: "2024-10-01T00:00:00Z",
				}),
				makeTrack("2", {
					title: "Track 2",
					artist: "Artist 2",
					album: "Album 2",
					duration_secs: 120,
					date_added: "2024-02-01T00:00:00Z",
				}),
			];
			const sorted = sortTracks(tracks, field, "asc");
			expect(sorted.map((track) => track.id)).toEqual(["2", "10"]);
			expect(sortTracks(tracks, field, "desc").map((track) => track.id)).toEqual([
				"10",
				"2",
			]);
		},
	);

	it("keeps invalid dates last and breaks ties deterministically", () => {
		const tracks = [
			makeTrack("bad", { title: "Same", date_added: "not-a-date" }),
			makeTrack("b", { title: "Same", date_added: "2024-01-01T00:00:00Z" }),
			makeTrack("a", { title: "Same", date_added: "2024-01-01T00:00:00Z" }),
		];

		expect(
			sortTracks(tracks, "date_added", "asc").map((track) => track.id),
		).toEqual(["a", "b", "bad"]);
		expect(
			sortTracks(tracks, "date_added", "desc").map((track) => track.id),
		).toEqual(["a", "b", "bad"]);
	});

	it("returns a sorted copy without mutating the filtered input", () => {
		const tracks = [
			makeTrack("z", { title: "Zebra" }),
			makeTrack("a", { title: "Apple" }),
		];
		const sorted = sortTracks(tracks, "title", "asc");

		expect(sorted).not.toBe(tracks);
		expect(tracks.map((track) => track.id)).toEqual(["z", "a"]);
		expect(sorted.map((track) => track.id)).toEqual(["a", "z"]);
	});

	it("preserves the parent-provided order until a sort is explicitly selected", () => {
		const tracks = [
			makeTrack("track-3", { title: "Third", disc_number: 2, track_number: 1 }),
			makeTrack("track-1", { title: "First", disc_number: 1, track_number: 1 }),
			makeTrack("track-2", { title: "Second", disc_number: 1, track_number: 2 }),
		];

		expect(orderTracks(tracks, null).map((track) => track.id)).toEqual([
			"track-3",
			"track-1",
			"track-2",
		]);
		expect(orderTracks(tracks, { field: "title", direction: "asc" }).map((track) => track.id)).toEqual([
			"track-1",
			"track-2",
			"track-3",
		]);
	});

	it("orders equal album and artist keys by disc and track before stable fallback", () => {
		const tracks = [
			makeTrack("later", { title: "Z", artist: "Artist", album: "Album", disc_number: 2, track_number: 1 }),
			makeTrack("first", { title: "A", artist: "Artist", album: "Album", disc_number: 1, track_number: 2 }),
			makeTrack("middle", { title: "Y", artist: "Artist", album: "Album", disc_number: 1, track_number: 1 }),
		];

		expect(sortTracks(tracks, "album", "asc").map((track) => track.id)).toEqual([
			"middle",
			"first",
			"later",
		]);
		expect(sortTracks(tracks, "artist", "asc").map((track) => track.id)).toEqual([
			"middle",
			"first",
			"later",
		]);
	});
});
