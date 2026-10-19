// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRestartableTimeout,
  scheduleRestartableTimeout,
  type TimeoutRef,
} from "./restartableTimeout";

describe("restartable timeout", () => {
  afterEach(() => vi.useRealTimers());

  it("clears a pending preview reset when a new interaction begins", () => {
    vi.useFakeTimers();
    const timeoutRef: TimeoutRef = { current: null };
    const resetPreview = vi.fn();

    scheduleRestartableTimeout(timeoutRef, resetPreview, 300);
    vi.advanceTimersByTime(250);

    clearRestartableTimeout(timeoutRef);
    vi.advanceTimersByTime(100);

    expect(resetPreview).not.toHaveBeenCalled();
    expect(timeoutRef.current).toBeNull();
  });

  it("replaces an older timeout and clears it during cleanup", () => {
    vi.useFakeTimers();
    const timeoutRef: TimeoutRef = { current: null };
    const resetPreview = vi.fn();

    scheduleRestartableTimeout(timeoutRef, resetPreview, 300);
    vi.advanceTimersByTime(250);
    scheduleRestartableTimeout(timeoutRef, resetPreview, 300);
    vi.advanceTimersByTime(250);
    expect(resetPreview).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(resetPreview).toHaveBeenCalledTimes(1);
    expect(timeoutRef.current).toBeNull();

    scheduleRestartableTimeout(timeoutRef, resetPreview, 300);
    clearRestartableTimeout(timeoutRef);
    vi.advanceTimersByTime(300);
    expect(resetPreview).toHaveBeenCalledTimes(1);
  });
});
