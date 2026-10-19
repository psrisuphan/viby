// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePlaybackProgressStore } from "./playbackProgressStore";
import { usePlayerStore } from "./playerStore";

describe("playbackProgressStore", () => {
  beforeEach(() =>
    usePlaybackProgressStore.setState({
      positionSecs: 0,
      durationSecs: 0,
      generation: 0,
      sequence: 0,
      seekPercent: null,
    }),
  );
  afterEach(() => cleanup());

  it("keeps control-view renders flat while a React progress subscriber updates", () => {
    let controlViewRenders = 0;
    let progressViewRenders = 0;
    const controlView = renderHook(() => {
      controlViewRenders += 1;
      return usePlayerStore((state) => state.volume);
    });
    const progressView = renderHook(() => {
      progressViewRenders += 1;
      return usePlaybackProgressStore((state) => state.positionSecs);
    });
    const controlRendersBeforeTicks = controlViewRenders;
    const progressRendersBeforeTicks = progressViewRenders;
    const tickCount = 100;

    for (let sequence = 1; sequence <= tickCount; sequence += 1) {
      act(() => {
        usePlaybackProgressStore
          .getState()
          .setProgress(sequence, 180, 1, sequence);
      });
    }

    expect(controlViewRenders).toBe(controlRendersBeforeTicks);
    expect(progressViewRenders - progressRendersBeforeTicks).toBe(tickCount);
    controlView.unmount();
    progressView.unmount();
  });

  it("updates only the lightweight progress values", () => {
    usePlaybackProgressStore.getState().setProgress(31.5, 180, 2, 10);

    expect(usePlaybackProgressStore.getState()).toMatchObject({
      positionSecs: 31.5,
      durationSecs: 180,
      generation: 2,
      sequence: 10,
    });
  });

  it("ignores stale updates across seeks and track changes", () => {
    const store = usePlaybackProgressStore.getState();
    store.setProgress(62, 180, 3, 1);
    store.setProgress(61, 180, 3, 0);
    store.setProgress(179, 240, 2, 99);

    expect(usePlaybackProgressStore.getState()).toMatchObject({
      positionSecs: 62,
      durationSecs: 180,
      generation: 3,
      sequence: 1,
    });
  });

  it("progress ticks do not notify player-state subscribers", () => {
    let notifications = 0;
    const unsubscribe = usePlayerStore.subscribe(() => notifications++);

    usePlaybackProgressStore.getState().setProgress(31.5, 180, 4, 1);

    unsubscribe();
    expect(notifications).toBe(0);
  });

  it("keeps high-frequency progress work isolated from player-state views", () => {
    let playerStateNotifications = 0;
    const playerSnapshot = usePlayerStore.getState();
    const unsubscribe = usePlayerStore.subscribe(
      () => playerStateNotifications++,
    );
    const startedAt = performance.now();

    for (let sequence = 1; sequence <= 5000; sequence++) {
      usePlaybackProgressStore
        .getState()
        .setProgress(sequence / 10, 240, 5, sequence);
    }

    const elapsedMs = performance.now() - startedAt;
    unsubscribe();

    expect(playerStateNotifications).toBe(0);
    expect(usePlayerStore.getState()).toBe(playerSnapshot);
    expect(usePlaybackProgressStore.getState()).toMatchObject({
      positionSecs: 500,
      generation: 5,
      sequence: 5000,
    });
    console.info(
      `playback-progress Zustand-store benchmark (not React render profiling): 5000 updates in ${elapsedMs.toFixed(2)} ms; player-state notifications: ${playerStateNotifications}`,
    );
  });
});
