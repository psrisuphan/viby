import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Track } from "../../types";

vi.mock("@tanstack/react-virtual", () => ({
	useVirtualizer: ({
		count,
		estimateSize,
	}: {
		count: number;
		estimateSize: () => number;
	}) => {
		const size = estimateSize();
		const virtualItems = Array.from({ length: count }, (_, index) => ({
			index,
			start: index * size,
			size,
		}));
		return {
			getVirtualItems: () => virtualItems,
			getTotalSize: () => count * size,
			isScrolling: false,
			scrollToIndex: vi.fn(),
		};
	},
}));

vi.mock("../../utils/useArtwork", () => ({
	useArtwork: () => ({ artworkUrl: null }),
}));

import SongTable from "./SongTable";

function makeTrack(id: string, title: string): Track {
	return {
		id,
		title,
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
	};
}

describe("SongTable source ordering", () => {
	it("renders tracks in the supplied playlist order until the user sorts", () => {
		const markup = renderToStaticMarkup(
			<SongTable
				tracks={[makeTrack("z", "Zebra"), makeTrack("a", "Apple")]}
				hideArtwork
			/>,
		);

		expect(markup.indexOf("Zebra")).toBeLessThan(markup.indexOf("Apple"));
		expect(markup).toContain('aria-pressed="false"');
	});
});
