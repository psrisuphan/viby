// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLibraryStore } from "../../stores/libraryStore";
import {
  getAlbumTracks,
  playTrack,
  playTracks,
  searchLibrary,
} from "../../utils/tauri";
import type { Album, SearchResults, Track } from "../../types";
import SearchModal from "./SearchModal";

vi.mock("../../utils/useArtwork", () => ({
  useArtwork: () => ({ artworkUrl: null }),
}));

vi.mock("../ui/CustomScrollbar", () => ({ default: () => null }));

vi.mock("../../utils/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../utils/tauri")>();
  return {
    ...actual,
    getAlbumTracks: vi.fn(),
    playTrack: vi.fn(),
    playTracks: vi.fn(),
    searchLibrary: vi.fn(),
  };
});

const track = {
  id: "track-search-1",
  title: "River Song",
  artist: "Ada Artist",
  album: "Quiet River",
  album_artist: "Ada Artist",
} as Track;

const album: Album = {
  name: "Quiet River",
  artist: "Ada Artist",
  year: 2024,
  track_count: 1,
  artwork_track_id: null,
};

const searchResults: SearchResults = {
  tracks: [track],
  albums: [album],
  artists: [],
};

async function renderSearchResults() {
  render(<SearchModal />);
  const input = screen.getByRole("textbox", {
    name: "Search all songs, albums, and artists",
  });
  fireEvent.change(input, { target: { value: "Quiet River" } });
  const trackResult = await screen.findByRole("button", {
    name: "Play River Song",
  });
  const albumResult = screen.getByRole("button", {
    name: "Open album Quiet River",
  });
  return { input, trackResult, albumResult };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
    { width: 1, height: 1 } as DOMRect,
  ] as unknown as DOMRectList);
  useLibraryStore.setState({ albums: [album] });
  vi.mocked(searchLibrary).mockResolvedValue(searchResults);
  vi.mocked(playTrack).mockResolvedValue(undefined);
  vi.mocked(getAlbumTracks).mockResolvedValue([]);
  vi.mocked(playTracks).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  useLibraryStore.setState({ albums: [] });
  vi.restoreAllMocks();
});

describe("SearchModal keyboard context menus", () => {
  it("opens a track menu with Shift+F10 without playing, and Escape restores the result", async () => {
    const { input, trackResult } = await renderSearchResults();

    expect(input).toBe(document.activeElement);
    expect(trackResult.tabIndex).toBe(0);
    trackResult.focus();
    expect(document.activeElement).toBe(trackResult);

    fireEvent.keyDown(trackResult, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu", { name: "Song actions" });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].textContent).toContain("Play");
    expect(playTrack).not.toHaveBeenCalled();

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(trackResult));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "Search songs, albums, and artists" })).toBeTruthy();
    expect(menu.dataset.dialogOwner).toBeTruthy();
    expect(playTrack).not.toHaveBeenCalled();

    fireEvent.doubleClick(trackResult);
    await waitFor(() => expect(playTrack).toHaveBeenCalledWith(track.id));
  });

  it("opens an album menu with the ContextMenu key and keeps album actions distinct", async () => {
    const { input, albumResult } = await renderSearchResults();

    expect(input).toBe(document.activeElement);
    albumResult.focus();
    expect(document.activeElement).toBe(albumResult);

    fireEvent.keyDown(albumResult, { key: "ContextMenu" });
    const menu = await screen.findByRole("menu", { name: "Album actions" });
    const items = screen.getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    expect(items[0].textContent).toContain("Play");
    expect(getAlbumTracks).not.toHaveBeenCalled();
    expect(playTracks).not.toHaveBeenCalled();

    fireEvent.keyDown(items[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1], { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(albumResult));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menu.dataset.dialogOwner).toBeTruthy();
    expect(getAlbumTracks).not.toHaveBeenCalled();
    expect(playTracks).not.toHaveBeenCalled();
  });
});
