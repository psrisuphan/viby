import { beforeEach, describe, expect, it } from "vitest";
import { invoke } from "./core";
import { listen } from "./event";
import { mockPlaybackState } from "./mocks";

type VolumeSnapshot = { volume: number; is_muted: boolean; shuffle: boolean };

describe("browser shim playback events", () => {
  beforeEach(() => {
    mockPlaybackState.volume = 0.8;
    mockPlaybackState.is_muted = false;
    mockPlaybackState.previous_volume = 0.8;
    mockPlaybackState.shuffle = false;
    mockPlaybackState.repeat_mode = "off";
  });

  it("emits a playback-state snapshot after each volume and mute command", async () => {
    const received: VolumeSnapshot[] = [];
    await listen<VolumeSnapshot>("playback-state", (event) => {
      received.push({
        volume: event.payload.volume,
        is_muted: event.payload.is_muted,
        shuffle: event.payload.shuffle,
      });
    });

    await invoke("set_volume", { volume: 0.4 });
    await invoke("toggle_mute");
    await invoke("toggle_mute");

    // The listener also receives a delayed initial snapshot; compare only the command results.
    expect(received.slice(-3)).toEqual([
      { volume: 0.4, is_muted: false, shuffle: false },
      { volume: 0, is_muted: true, shuffle: false },
      { volume: 0.4, is_muted: false, shuffle: false },
    ]);
  });

  it("emits playback-state and queue-changed for shuffle toggles", async () => {
    const playbackEvents: boolean[] = [];
    const queueEvents: number[] = [];
    await listen<VolumeSnapshot>("playback-state", (event) => {
      playbackEvents.push(event.payload.shuffle);
    });
    await listen<{ current_index: number }>("queue-changed", () => {
      queueEvents.push(1);
    });

    await invoke("toggle_shuffle");

    expect(playbackEvents[playbackEvents.length - 1]).toBe(true);
    expect(queueEvents.length).toBeGreaterThan(0);
  });
});
