export interface PlaybackPreferences {
  volume: number;
  isMuted: boolean;
  previousVolume: number;
  shuffle: boolean;
  repeatMode: "off" | "one" | "all";
}

function unitValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function toBackendVolume(value: number, exponential: boolean): number {
  return exponential ? value * value * value : value;
}

export function parseLegacyPlaybackPreferences(
  serialized: string | null,
  exponentialVolume: boolean,
): PlaybackPreferences | null {
  if (!serialized) return null;

  try {
    const root: unknown = JSON.parse(serialized);
    if (!root || typeof root !== "object" || !("state" in root)) return null;
    const state = (root as { state?: unknown }).state;
    if (!state || typeof state !== "object") return null;
    const legacy = state as Record<string, unknown>;
    if (
      !["volume", "isMuted", "previousVolume", "shuffle", "repeatMode"].some(
        (key) => key in legacy,
      )
    ) {
      return null;
    }

    const displayVolume = unitValue(legacy.volume, 1);
    const displayPreviousVolume = unitValue(
      legacy.previousVolume,
      displayVolume > 0 ? displayVolume : 1,
    );
    const isMuted = legacy.isMuted === true || displayVolume === 0;
    const repeatMode =
      legacy.repeatMode === "one" || legacy.repeatMode === "all"
        ? legacy.repeatMode
        : "off";

    return {
      volume: isMuted ? 0 : toBackendVolume(displayVolume, exponentialVolume),
      isMuted,
      previousVolume: toBackendVolume(displayPreviousVolume, exponentialVolume),
      shuffle: legacy.shuffle === true,
      repeatMode,
    };
  } catch {
    return null;
  }
}

export function readLegacyPlaybackPreferences(
  exponentialVolume: boolean,
): PlaybackPreferences | null {
  try {
    return parseLegacyPlaybackPreferences(
      localStorage.getItem("viby-player-storage"),
      exponentialVolume,
    );
  } catch {
    return null;
  }
}
