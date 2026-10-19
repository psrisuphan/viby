export type TimeoutRef = {
  current: ReturnType<typeof window.setTimeout> | null;
};

export function clearRestartableTimeout(timeoutRef: TimeoutRef): void {
  if (timeoutRef.current !== null) {
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }
}

export function scheduleRestartableTimeout(
  timeoutRef: TimeoutRef,
  callback: () => void,
  delayMs: number,
): void {
  clearRestartableTimeout(timeoutRef);
  timeoutRef.current = window.setTimeout(() => {
    timeoutRef.current = null;
    callback();
  }, delayMs);
}
