import { useEffect, useMemo, useRef, useState } from "react";
import {
  clearBrowserInvokeLog,
  failNextBrowserInvoke,
  getBrowserInvokeLog,
} from "../browser-shims/core";
import {
  mockAlbums,
  mockArtists,
  mockPlaybackState,
  mockTracks,
} from "../browser-shims/mocks";
import SongTable from "../components/library/SongTable";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";
import { useUiStore } from "../stores/uiStore";
import type { Track } from "../types";

function makeLongList(): Track[] {
  return Array.from({ length: 120 }, (_, index) => {
    const source = mockTracks[index % mockTracks.length];
    return {
      ...source,
      id: `t14-track-${String(index).padStart(3, "0")}`,
      title: `Song ${String(index).padStart(3, "0")}`,
    };
  });
}

export default function T14KeyboardRoute() {
  const allTracks = useMemo(makeLongList, []);
  const [filter, setFilter] = useState("");
  const [descending, setDescending] = useState(false);
  const [invokeLog, setInvokeLog] = useState(getBrowserInvokeLog);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectedArtist = useUiStore((state) => state.selectedArtist);
  const selectedAlbum = useUiStore((state) => state.selectedAlbum);

  const tracks = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const filtered = query
      ? allTracks.filter((track) => track.title.toLowerCase().includes(query))
      : [...allTracks];
    return descending ? filtered.reverse() : filtered;
  }, [allTracks, descending, filter]);

  useEffect(() => {
    useLibraryStore.getState().setAlbums(mockAlbums);
    useLibraryStore.getState().setArtists(mockArtists);
    usePlayerStore.getState().setPlaybackSnapshot(mockPlaybackState);
    const updateLog = () => setInvokeLog(getBrowserInvokeLog());
    window.addEventListener("viby-test-invoke", updateLog);
    clearBrowserInvokeLog();
    setInvokeLog(getBrowserInvokeLog());
    return () => window.removeEventListener("viby-test-invoke", updateLog);
  }, []);

  const routeRoot = () =>
    document.querySelector<HTMLElement>('[data-testid="t14-keyboard-route"]');
  const songListRoot = () =>
    routeRoot()?.querySelector<HTMLElement>(".song-table-container");
  const focusFirstRow = () => {
    scrollRef.current?.scrollTo({ top: 0 });
    window.setTimeout(
      () =>
        songListRoot()
          ?.querySelector<HTMLElement>('[data-song-index="0"]')
          ?.focus(),
      50,
    );
  };
  const focusRovingRow = () =>
    songListRoot()
      ?.querySelector<HTMLElement>('[data-song-index][tabindex="0"]')
      ?.focus();
  const focusFirstArtistButton = () =>
    songListRoot()
      ?.querySelector<HTMLButtonElement>(
        ".song-row-navigation[aria-label^='Go to artist']",
      )
      ?.focus();
  const focusFirstAlbumButton = () =>
    songListRoot()
      ?.querySelector<HTMLButtonElement>(
        ".song-row-navigation[aria-label^='Go to album']",
      )
      ?.focus();

  return (
    <div
      data-testid="t14-keyboard-route"
      style={{
        position: "fixed",
        inset: 12,
        zIndex: 10000,
        padding: 16,
        overflow: "auto",
        background: "var(--bg-primary)",
        color: "var(--text-primary)",
      }}
    >
      <h1>T14 keyboard and virtual list check</h1>
      <div
        style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}
      >
        <label>
          Filter test songs
          <input
            aria-label="Filter test songs"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <button type="button" onClick={() => setDescending((value) => !value)}>
          Toggle test song sort
        </button>
        <button
          type="button"
          onClick={() => {
            setFilter("");
            setDescending(false);
          }}
        >
          Reset test list
        </button>
        <button type="button" onClick={focusFirstRow}>
          Focus first song row
        </button>
        <button type="button" onClick={focusRovingRow}>
          Focus current song tab stop
        </button>
        <button type="button" onClick={focusFirstArtistButton}>
          Focus first artist button
        </button>
        <button type="button" onClick={focusFirstAlbumButton}>
          Focus first album button
        </button>
        <button
          type="button"
          onClick={() =>
            failNextBrowserInvoke("play_track", "controlled play failure")
          }
        >
          Fail next track play
        </button>
        <button
          type="button"
          onClick={() =>
            failNextBrowserInvoke(
              "add_tracks_to_queue",
              "controlled queue failure",
            )
          }
        >
          Fail next bulk queue action
        </button>
        <button type="button" onClick={clearBrowserInvokeLog}>
          Clear IPC log
        </button>
      </div>
      <p>
        Rows in current view:{" "}
        <output aria-label="Current row count">{tracks.length}</output>
      </p>
      <p>
        Selected artist:{" "}
        <output aria-label="Selected artist">
          {selectedArtist?.name ?? "none"}
        </output>
      </p>
      <p>
        Selected album:{" "}
        <output aria-label="Selected album">
          {selectedAlbum?.name ?? "none"}
        </output>
      </p>
      <div
        ref={scrollRef}
        role="region"
        aria-label="Virtual song list test viewport"
        style={{
          height: 420,
          overflowY: "auto",
          border: "1px solid var(--border)",
        }}
      >
        <SongTable tracks={tracks} scrollRef={scrollRef} />
      </div>
      <pre
        role="log"
        data-testid="browser-ipc-log"
        aria-label="Browser test IPC log"
      >
        {JSON.stringify(invokeLog)}
      </pre>
    </div>
  );
}
