import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "./toastStore";

describe("toast notifications", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({
      toasts: [],
      currentAnnouncement: null,
      pendingAnnouncements: [],
    });
  });

  afterEach(() => {
    for (const toast of useToastStore.getState().toasts) {
      useToastStore.getState().removeToast(toast.id);
    }
    useToastStore.setState({
      currentAnnouncement: null,
      pendingAnnouncements: [],
    });
    vi.runAllTimers();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps several notifications visible together", () => {
    useToastStore.getState().addToast("Track queued", "success");
    useToastStore.getState().addToast("Playback failed", "error", 0);

    expect(
      useToastStore.getState().toasts.map((toast) => toast.message),
    ).toEqual(["Track queued", "Playback failed"]);
  });

  it("keeps errors until dismissed", () => {
    useToastStore.getState().addToast("Database is unavailable", "error");

    vi.advanceTimersByTime(60_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    const [toast] = useToastStore.getState().toasts;
    useToastStore.getState().removeToast(toast.id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("pauses expiration while a notification is hovered or focused", () => {
    useToastStore.getState().addToast("Saved", "success", 3000);
    const [toast] = useToastStore.getState().toasts;

    vi.advanceTimersByTime(1200);
    useToastStore.getState().pauseToast(toast.id, "focus");
    vi.advanceTimersByTime(30_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().pauseToast(toast.id, "hover");
    useToastStore.getState().resumeToast(toast.id, "focus");
    vi.advanceTimersByTime(30_000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resumeToast(toast.id, "hover");
    vi.advanceTimersByTime(1799);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("does not remove a toast while its close button has focus at expiration", () => {
    useToastStore.getState().addToast("Saved", "success", 1000);
    const [toast] = useToastStore.getState().toasts;

    vi.advanceTimersByTime(999);
    useToastStore.getState().pauseToast(toast.id, "focus");
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(1);

    useToastStore.getState().resumeToast(toast.id, "focus");
    vi.advanceTimersByTime(1);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("removes timed notifications automatically", () => {
    useToastStore.getState().addToast("Saved", "success", 5000);

    vi.advanceTimersByTime(5000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("drops a pending announcement when its notification is dismissed", () => {
    const announced: string[] = [];
    let previousAnnouncementId: string | null = null;
    const unsubscribe = useToastStore.subscribe((state) => {
      const current = state.currentAnnouncement;
      const nextId = current?.id ?? null;
      if (current && nextId !== previousAnnouncementId) {
        announced.push(current.message);
      }
      previousAnnouncementId = nextId;
    });

    useToastStore
      .getState()
      .addToast("First action succeeded", "success", 1000);
    useToastStore.getState().addToast("Second action failed", "error", 10);
    const [first, second] = useToastStore.getState().toasts;

    expect(useToastStore.getState().currentAnnouncement).toMatchObject({
      toastId: first.id,
      message: first.message,
      type: first.type,
    });
    expect(useToastStore.getState().pendingAnnouncements).toMatchObject([
      { toastId: second.id, message: second.message, type: second.type },
    ]);

    useToastStore.getState().removeToast(second.id);
    expect(useToastStore.getState().pendingAnnouncements).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().currentAnnouncement?.message).toBe(
      first.message,
    );

    vi.advanceTimersByTime(1180);
    expect(useToastStore.getState().currentAnnouncement).toBeNull();
    unsubscribe();
    expect(announced).toEqual([first.message]);
  });

  it("still announces a notification that expires before its turn", () => {
    const announced: string[] = [];
    let previousId: string | null = null;
    const unsubscribe = useToastStore.subscribe((state) => {
      const current = state.currentAnnouncement;
      if (current && current.id !== previousId) announced.push(current.message);
      previousId = current?.id ?? null;
    });

    useToastStore
      .getState()
      .addToast("First action succeeded", "success", 1000);
    useToastStore.getState().addToast("Second action finished", "info", 10);

    vi.advanceTimersByTime(1000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(1);

    vi.advanceTimersByTime(1180);
    unsubscribe();
    expect(announced).toEqual([
      "First action succeeded",
      "Second action finished",
    ]);
  });

  it("coalesces repeated permanent errors while announcing the updated count", () => {
    const announcedMessages: string[] = [];
    let previousId: string | null = null;
    const unsubscribe = useToastStore.subscribe((state) => {
      const current = state.currentAnnouncement;
      const currentId = current?.id ?? null;
      if (current && currentId !== previousId)
        announcedMessages.push(current.message);
      previousId = currentId;
    });

    useToastStore.getState().addToast("Playback failed", "error");
    useToastStore.getState().addToast("Playback failed", "error");
    useToastStore.getState().addToast("Playback failed", "error");
    const [toast] = useToastStore.getState().toasts;

    expect(useToastStore.getState().toasts).toHaveLength(1);
    expect(toast.occurrences).toBe(3);
    expect(useToastStore.getState().currentAnnouncement?.toastId).toBe(
      toast.id,
    );
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(1);
    vi.advanceTimersByTime(1100);
    expect(useToastStore.getState().currentAnnouncement).toBeNull();
    vi.advanceTimersByTime(80);
    expect(useToastStore.getState().currentAnnouncement).toMatchObject({
      toastId: toast.id,
      message: "Playback failed (repeated 3 times)",
    });
    unsubscribe();
    expect(announcedMessages).toEqual([
      "Playback failed",
      "Playback failed (repeated 3 times)",
    ]);
  });

  it("keeps different permanent failures separate in the announcement queue", () => {
    useToastStore.getState().addToast("Queue update failed", "error");
    useToastStore.getState().addToast("Could not load album tracks", "error");

    const [first, second] = useToastStore.getState().toasts;
    expect(useToastStore.getState().currentAnnouncement).toMatchObject({
      toastId: first.id,
      message: "Queue update failed",
    });
    expect(useToastStore.getState().pendingAnnouncements).toMatchObject([
      { toastId: second.id, message: "Could not load album tracks" },
    ]);

    vi.advanceTimersByTime(1180);
    expect(useToastStore.getState().currentAnnouncement).toMatchObject({
      toastId: second.id,
      message: "Could not load album tracks",
    });
  });

  it("cancels a repeated error announcement when its toast is dismissed", () => {
    useToastStore.getState().addToast("Playback failed", "error");
    const [toast] = useToastStore.getState().toasts;
    useToastStore.getState().addToast("Playback failed", "error");

    expect(useToastStore.getState().currentAnnouncement?.toastId).toBe(
      toast.id,
    );
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(1);

    useToastStore.getState().removeToast(toast.id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().currentAnnouncement).toBeNull();
    expect(useToastStore.getState().pendingAnnouncements).toEqual([]);
  });

  it("evicts an unfocused error while preserving a focused error and announcements", () => {
    for (let index = 1; index <= 5; index += 1) {
      useToastStore.getState().addToast(`Failure ${index}`, "error");
    }
    const focused = useToastStore.getState().toasts[0];
    useToastStore.getState().pauseToast(focused.id, "focus");
    useToastStore.getState().addToast("Failure 6", "error");

    const visible = useToastStore.getState().toasts;
    expect(visible).toHaveLength(5);
    expect(visible.map((toast) => toast.message)).toContain("Failure 1");
    expect(visible.map((toast) => toast.message)).toContain("Failure 6");
    expect(visible.map((toast) => toast.message)).not.toContain("Failure 2");
    expect(useToastStore.getState().currentAnnouncement?.message).toBe(
      "Failure 1",
    );
    expect(
      useToastStore.getState().pendingAnnouncements.map((item) => item.message),
    ).toEqual([
      "Failure 2",
      "Failure 3",
      "Failure 4",
      "Failure 5",
      "Failure 6",
    ]);
  });

  it("shows a bounded overflow error while every visible error is focus-paused", () => {
    for (let index = 1; index <= 5; index += 1) {
      useToastStore.getState().addToast(`Failure ${index}`, "error");
    }
    const focused = useToastStore.getState().toasts;
    for (const toast of focused) {
      useToastStore.getState().pauseToast(toast.id, "focus");
    }

    useToastStore.getState().addToast("Failure 6", "error");
    const firstOverflow = useToastStore
      .getState()
      .toasts.find((toast) => toast.overflow);
    expect(firstOverflow).toMatchObject({
      message: "Failure 6",
      overflowCount: 1,
      occurrences: 1,
    });
    expect(useToastStore.getState().toasts).toHaveLength(6);
    expect(
      useToastStore.getState().toasts.map((toast) => toast.message),
    ).toEqual([
      "Failure 1",
      "Failure 2",
      "Failure 3",
      "Failure 4",
      "Failure 5",
      "Failure 6",
    ]);

    useToastStore.getState().addToast("Failure 7", "error");
    useToastStore.getState().addToast("Failure 7", "error");
    const updatedOverflow = useToastStore
      .getState()
      .toasts.find((toast) => toast.overflow);
    expect(updatedOverflow).toMatchObject({
      id: firstOverflow?.id,
      message: "Failure 7",
      overflowCount: 2,
      occurrences: 2,
    });
    expect(useToastStore.getState().toasts).toHaveLength(6);
    expect(
      useToastStore
        .getState()
        .pendingAnnouncements.map((announcement) => announcement.message),
    ).toContain("Failure 7 (repeated 2 times)");

    useToastStore.getState().addToast("Failure 6", "error");
    const repeatedOlderOverflow = useToastStore
      .getState()
      .toasts.find((toast) => toast.overflow);
    expect(repeatedOlderOverflow).toMatchObject({
      id: firstOverflow?.id,
      message: "Failure 6",
      overflowCount: 2,
      occurrences: 2,
    });
    expect(
      useToastStore
        .getState()
        .pendingAnnouncements.map((announcement) => announcement.message),
    ).toContain("Failure 6 (repeated 2 times)");

    useToastStore.getState().resumeToast(focused[0].id, "focus");
    useToastStore.getState().addToast("Failure 8", "error");
    const afterResume = useToastStore.getState().toasts;
    expect(afterResume).toHaveLength(6);
    expect(afterResume.map((toast) => toast.message)).not.toContain(
      "Failure 1",
    );
    expect(afterResume.map((toast) => toast.message)).toContain("Failure 2");
    expect(afterResume.map((toast) => toast.message)).toContain("Failure 8");
    expect(afterResume.find((toast) => toast.overflow)).toMatchObject({
      id: firstOverflow?.id,
      message: "Failure 6",
    });

    for (let index = 9; index <= 20; index += 1) {
      useToastStore.getState().addToast(`Failure ${index}`, "error");
    }
    expect(
      useToastStore.getState().toasts.filter((toast) => toast.type === "error"),
    ).toHaveLength(6);
    expect(
      useToastStore.getState().toasts.find((toast) => toast.overflow)
        ?.overflowEntries?.length,
    ).toBeLessThanOrEqual(20);
  });

  it("bounds overflow announcements during distinct error floods and preserves repeats", () => {
    for (let index = 1; index <= 5; index += 1) {
      useToastStore.getState().addToast(`Flood ${index}`, "error");
    }
    const focused = useToastStore.getState().toasts;
    for (const toast of focused) {
      useToastStore.getState().pauseToast(toast.id, "focus");
    }

    for (let index = 6; index <= 200; index += 1) {
      useToastStore.getState().addToast(`Flood ${index}`, "error");
    }

    const overflow = useToastStore
      .getState()
      .toasts.find((toast) => toast.overflow);
    if (!overflow) throw new Error("Expected an overflow toast after the flood");
    expect(overflow).toMatchObject({ message: "Flood 200" });
    expect(useToastStore.getState().toasts).toHaveLength(6);
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(5);
    expect(
      useToastStore
        .getState()
        .pendingAnnouncements.filter((announcement) => announcement.toastId === overflow?.id),
    ).toMatchObject([{ message: "Flood 200", type: "error" }]);

    useToastStore.getState().addToast("Flood 200", "error");
    const repeatedOverflow = useToastStore
      .getState()
      .toasts.find((toast) => toast.overflow);
    expect(repeatedOverflow).toMatchObject({
      id: overflow?.id,
      message: "Flood 200",
      occurrences: 2,
    });
    expect(
      useToastStore
        .getState()
        .pendingAnnouncements.filter((announcement) => announcement.toastId === overflow?.id),
    ).toMatchObject([
      { message: "Flood 200 (repeated 2 times)", type: "error" },
    ]);
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(5);

    useToastStore.getState().addToast("Flood 201", "error");
    expect(
      useToastStore
        .getState()
        .pendingAnnouncements.filter((announcement) => announcement.toastId === overflow?.id),
    ).toMatchObject([{ message: "Flood 201", type: "error" }]);
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(5);

    useToastStore.getState().removeToast(overflow.id);
    expect(
      useToastStore
        .getState()
        .pendingAnnouncements.some((announcement) => announcement.toastId === overflow?.id),
    ).toBe(false);
    expect(
      useToastStore.getState().toasts.some((toast) => toast.overflow),
    ).toBe(false);
  });
});
