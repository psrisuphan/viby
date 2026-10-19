export type PlaybackDebugLevel = "debug" | "info" | "warn";

export function shouldEnablePlaybackDebug(
  isDevelopment: boolean,
  storedValue: string | null,
): boolean {
  return isDevelopment || storedValue === "1";
}

export function isPlaybackDebugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  try {
    const storedValue =
      typeof localStorage === "undefined"
        ? null
        : localStorage.getItem("vibyDebugPlayback");
    return shouldEnablePlaybackDebug(false, storedValue);
  } catch {
    return false;
  }
}

export function logPlaybackDebug(
  level: PlaybackDebugLevel,
  event: string,
  details?: Record<string, string | number | boolean | null>,
): void {
  if (!isPlaybackDebugEnabled()) return;
  console[level](`[VibyDebug] ${event}`, details ?? "");
}
