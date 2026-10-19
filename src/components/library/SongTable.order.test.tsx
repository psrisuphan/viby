// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(cleanup);

describe("SongTable source ordering", () => {
  it("renders tracks in the supplied playlist order until the user sorts", () => {
    render(
      <SongTable
        tracks={[makeTrack("z", "Zebra"), makeTrack("a", "Apple")]}
        hideArtwork
      />,
    );

    const list = screen.getByRole("list", { name: "Songs" });
    expect(list.getAttribute("role")).toBe("list");

    const rows = screen.getAllByRole("listitem");
    expect(
      rows.map((row) => row.querySelector(".col-title")?.textContent),
    ).toEqual(["Zebra", "Apple"]);
  });

  it("cycles a user sort back to the original source order", () => {
    render(
      <SongTable
        tracks={[
          makeTrack("z", "Zebra"),
          makeTrack("a", "Apple"),
          makeTrack("e", "Echo"),
        ]}
        hideArtwork
      />,
    );

    const readTitles = () =>
      screen
        .getAllByRole("listitem")
        .map((row) => row.querySelector(".col-title")?.textContent);

    fireEvent.click(screen.getByRole("button", { name: "Sort by Title, ascending" }));
    expect(readTitles()).toEqual(["Apple", "Echo", "Zebra"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Title, ascending" }));
    expect(readTitles()).toEqual(["Zebra", "Echo", "Apple"]);
    fireEvent.click(screen.getByRole("button", { name: "Sort by Title, descending" }));
    expect(readTitles()).toEqual(["Zebra", "Apple", "Echo"]);
  });
});
