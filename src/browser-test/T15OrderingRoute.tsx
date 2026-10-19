import { useMemo } from "react";
import { mockTracks } from "../browser-shims/mocks";
import SongTable from "../components/library/SongTable";
import type { Track } from "../types";

export default function T15OrderingRoute() {
  const tracks = useMemo<Track[]>(
    () => [
      { ...mockTracks[0], id: "source-3", title: "Zulu Source First" },
      { ...mockTracks[1], id: "source-1", title: "Alpha Source Second" },
      { ...mockTracks[2], id: "source-2", title: "Echo Source Third" },
    ],
    [],
  );

  return (
    <section
      data-testid="t15-ordering-route"
      style={{
        position: "fixed",
        inset: 16,
        zIndex: 10000,
        overflow: "auto",
        padding: 16,
        background: "var(--bg-primary)",
        color: "var(--text-primary)",
      }}
    >
      <h1>T15 source order check</h1>
      <output data-testid="t15-input-order">
        {tracks.map((track) => track.id).join(",")}
      </output>
      <div style={{ height: 300, overflowY: "auto" }}>
        <SongTable tracks={tracks} />
      </div>
    </section>
  );
}
