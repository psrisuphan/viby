// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlayerStore } from "../../stores/playerStore";
import { setVolume } from "../../utils/tauri";
import FullscreenPlayer from "./FullscreenPlayer";

vi.mock("../../utils/tauri", () => ({
  setVolume: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../utils/useArtwork", () => ({
  useArtwork: () => ({ artworkUrl: null }),
}));

describe("FullscreenPlayer volume drag interrupted by unmount", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(setVolume).mockClear();
    usePlayerStore.setState({ volume: 0.5, isMuted: false });
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }));
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // jsdom has no 2D canvas; the visualizer only needs a context that accepts draw calls.
    const canvasContext: unknown = new Proxy(() => {}, {
      get: () => canvasContext,
      apply: () => canvasContext,
      set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => canvasContext as CanvasRenderingContext2D,
    );
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.hasPointerCapture = () => true;
    Element.prototype.releasePointerCapture = () => {};
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 100,
      bottom: 10,
      width: 100,
      height: 10,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reverts once to the starting volume and schedules no preview reset after unmount", () => {
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const previewResetsScheduled = () =>
      setTimeoutSpy.mock.calls.filter(([, delay]) => delay === 300).length;
    const { getByRole, unmount } = render(
      <FullscreenPlayer onExit={() => {}} />,
    );

    fireEvent.pointerDown(getByRole("slider", { name: "Fullscreen volume" }), {
      pointerId: 7,
      button: 0,
      isPrimary: true,
      clientX: 80,
    });
    expect(setVolume).toHaveBeenCalledTimes(1);
    expect(setVolume).toHaveBeenLastCalledWith(0.8, undefined);
    expect(previewResetsScheduled()).toBe(0);

    unmount();

    expect(setVolume).toHaveBeenCalledTimes(2);
    expect(setVolume).toHaveBeenLastCalledWith(0.5, { immediate: true });
    expect(previewResetsScheduled()).toBe(0);

    vi.advanceTimersByTime(400);
    expect(setVolume).toHaveBeenCalledTimes(2);
  });
});
