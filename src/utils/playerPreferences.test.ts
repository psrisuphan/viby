import { describe, expect, it } from "vitest";
import { parseLegacyPlaybackPreferences } from "./playerPreferences";

describe("legacy playback preference migration", () => {
  it("converts the saved display volume to backend linear volume", () => {
    const raw = JSON.stringify({
      state: {
        volume: 0.5,
        previousVolume: 0.8,
        isMuted: false,
        shuffle: true,
        repeatMode: "all",
      },
    });

    expect(parseLegacyPlaybackPreferences(raw, true)).toEqual({
      volume: 0.125,
      isMuted: false,
      previousVolume: 0.5120000000000001,
      shuffle: true,
      repeatMode: "all",
    });
  });

  it("preserves the previous audible level when migrating muted state", () => {
    const raw = JSON.stringify({
      state: { volume: 0, previousVolume: 0.4, isMuted: true },
    });

    expect(parseLegacyPlaybackPreferences(raw, false)).toMatchObject({
      volume: 0,
      isMuted: true,
      previousVolume: 0.4,
    });
  });

  it("ignores malformed or unrelated persisted state", () => {
    expect(parseLegacyPlaybackPreferences("{", false)).toBeNull();
    expect(
      parseLegacyPlaybackPreferences(
        JSON.stringify({ state: { theme: "dark" } }),
        false,
      ),
    ).toBeNull();
  });
});
