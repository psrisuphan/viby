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
    expect(useToastStore.getState().currentAnnouncement?.toastId).toBe(toast.id);
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

    expect(useToastStore.getState().currentAnnouncement?.toastId).toBe(toast.id);
    expect(useToastStore.getState().pendingAnnouncements).toHaveLength(1);

    useToastStore.getState().removeToast(toast.id);
    expect(useToastStore.getState().toasts).toHaveLength(0);
    expect(useToastStore.getState().currentAnnouncement).toBeNull();
    expect(useToastStore.getState().pendingAnnouncements).toEqual([]);
  });

  it("caps visible errors without dropping distinct queued announcements or focused errors", () => {
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
});
