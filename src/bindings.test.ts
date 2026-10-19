import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

import {
  commands,
  events,
  type RepeatMode,
  type ScanProgress,
  type ScanStatus,
} from "./bindings";

describe("generated Rust IPC contract", () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(null);
    mocks.listen.mockReset().mockResolvedValue(() => {});
  });

  it("keeps command names, argument casing, and the repeat union in sync", async () => {
    const trackIds = ["track-3", "track-1"];
    const repeatMode: RepeatMode = "all";

    await commands.playTracks(trackIds, 1, true);
    await commands.setRepeat(repeatMode);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "play_tracks", {
      trackIds,
      startIndex: 1,
      shuffle: true,
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "set_repeat", {
      mode: "all",
    });
    expectTypeOf<
      Parameters<typeof commands.setRepeat>[0]
    >().toEqualTypeOf<RepeatMode>();
  });

  it("exposes typed playback and scan event names", () => {
    events.playbackState.listen(() => {});
    events.scanProgress.listen(() => {});

    expect(mocks.listen).toHaveBeenNthCalledWith(
      1,
      "playback-state",
      expect.any(Function),
    );
    expect(mocks.listen).toHaveBeenNthCalledWith(
      2,
      "scan-progress",
      expect.any(Function),
    );
    expectTypeOf<ScanProgress["status"]>().toEqualTypeOf<ScanStatus>();
  });
});
