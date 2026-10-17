import { beforeEach, describe, expect, it } from "vitest";
import { useLibraryStore } from "./libraryStore";
import type { Track } from "../types";

describe("library loading and scan state", () => {
	beforeEach(() => {
		useLibraryStore.setState({
			tracks: [],
			albums: [],
			artists: [],
			playlists: [],
			isLoaded: false,
			isLoading: true,
			libraryLoadError: null,
			isScanning: false,
			scanProgress: 0,
			scanStatusText: "",
			scanError: null,
		});
	});

	it("keeps the current library available while a rescan runs", () => {
		const track = { id: "track-1" } as Track;
		const library = useLibraryStore.getState();
		library.setLibraryData({
			tracks: [track],
			albums: [],
			artists: [],
			playlists: [],
		});

		useLibraryStore.getState().setScanState(true, 20, "Scanning 1 / 5 files");

		expect(useLibraryStore.getState().tracks).toEqual([track]);
		expect(useLibraryStore.getState().isLoaded).toBe(true);
		expect(useLibraryStore.getState().isScanning).toBe(true);
	});

	it("exposes load errors and clears them when retry starts", () => {
		const library = useLibraryStore.getState();
		library.setLibraryLoadError("Database is unavailable");

		expect(useLibraryStore.getState().libraryLoadError).toBe("Database is unavailable");
		expect(useLibraryStore.getState().isLoaded).toBe(false);
		expect(useLibraryStore.getState().isLoading).toBe(false);

		useLibraryStore.getState().setLibraryLoading();

		expect(useLibraryStore.getState().libraryLoadError).toBeNull();
		expect(useLibraryStore.getState().isLoading).toBe(true);
	});

	it("preserves loaded data when a refresh fails", () => {
		const track = { id: "track-1" } as Track;
		useLibraryStore.getState().setLibraryData({
			tracks: [track],
			albums: [],
			artists: [],
			playlists: [],
		});

		useLibraryStore.getState().setLibraryLoadError("Database is unavailable");

		expect(useLibraryStore.getState().tracks).toEqual([track]);
		expect(useLibraryStore.getState().isLoaded).toBe(true);
	});
});
