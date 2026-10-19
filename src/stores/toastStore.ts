import { create } from "zustand";

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const toastRemainingMs = new Map<string, number>();
const toastTimeoutStartedAt = new Map<string, number>();
const toastPauseReasons = new Map<string, Set<string>>();
const MAX_VISIBLE_ERROR_TOASTS = 5;
const MAX_OVERFLOW_ERROR_KEYS = 20;

function clearToastTimer(id: string) {
  const timer = toastTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
  toastTimeoutStartedAt.delete(id);
}

export interface Toast {
  id: string;
  message: string;
  type: "info" | "success" | "error";
  duration?: number;
  occurrences?: number;
  overflow?: boolean;
  overflowCount?: number;
  overflowEntries?: Array<{ message: string; occurrences: number }>;
}

export interface ToastAnnouncement {
  id: string;
  toastId: string;
  message: string;
  type: Toast["type"];
  dedupeKey?: string;
}

interface ToastState {
  toasts: Toast[];
  currentAnnouncement: ToastAnnouncement | null;
  pendingAnnouncements: ToastAnnouncement[];
  addToast: (message: string, type?: Toast["type"], duration?: number) => void;
  removeToast: (id: string) => void;
  pauseToast: (id: string, reason: string) => void;
  resumeToast: (id: string, reason: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => {
  let announcementTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleToastRemoval = (id: string, delayMs: number) => {
    if (delayMs <= 0) return;
    toastRemainingMs.set(id, delayMs);
    toastTimeoutStartedAt.set(id, Date.now());
    toastTimers.set(
      id,
      setTimeout(() => {
        toastTimers.delete(id);
        toastTimeoutStartedAt.delete(id);
        toastRemainingMs.delete(id);
        toastPauseReasons.delete(id);
        set((state) => ({
          toasts: state.toasts.filter((toast) => toast.id !== id),
        }));
      }, delayMs),
    );
  };

  const showNextAnnouncement = () => {
    if (announcementTimer !== null) return;
    const next = get().pendingAnnouncements[0];
    if (!next) return;

    set((state) => ({
      currentAnnouncement: next,
      pendingAnnouncements: state.pendingAnnouncements.slice(1),
    }));
    announcementTimer = setTimeout(() => {
      set({ currentAnnouncement: null });
      announcementTimer = setTimeout(() => {
        announcementTimer = null;
        showNextAnnouncement();
      }, 80);
    }, 1100);
  };

  const queueAnnouncement = (
    pending: ToastAnnouncement[],
    announcement: ToastAnnouncement,
    coalesceByToast = false,
  ) => {
    const existingIndex = pending.findIndex(
      (item) =>
        item.toastId === announcement.toastId &&
        (coalesceByToast || item.dedupeKey === announcement.dedupeKey),
    );
    if (existingIndex < 0) return [...pending, announcement];
    if (coalesceByToast) {
      return [
        ...pending.slice(0, existingIndex),
        ...pending.slice(existingIndex + 1),
        announcement,
      ];
    }
    return pending.map((item, index) =>
      index === existingIndex ? announcement : item,
    );
  };

  return {
    toasts: [],
    currentAnnouncement: null,
    pendingAnnouncements: [],
    addToast: (message, type = "info", duration) => {
      const effectiveDuration = type === "error" ? 0 : (duration ?? 3000);
      let scheduledId: string | null = null;
      set((state) => {
        if (type === "error") {
          const existing = state.toasts.find(
            (toast) =>
              toast.type === "error" &&
              (toast.message === message ||
                toast.overflowEntries?.some(
                  (entry) => entry.message === message,
                )),
          );
          if (existing) {
            const previousOverflowEntries = existing.overflowEntries ?? [
              {
                message: existing.message,
                occurrences: existing.occurrences ?? 1,
              },
            ];
            const previousEntry = previousOverflowEntries.find(
              (entry) => entry.message === message,
            );
            const occurrences =
              (previousEntry?.occurrences ?? existing.occurrences ?? 1) + 1;
            const announcement: ToastAnnouncement = {
              id: crypto.randomUUID(),
              toastId: existing.id,
              message: `${message} (repeated ${occurrences} times)`,
              type,
              dedupeKey: message,
            };
            return {
              toasts: state.toasts.map((toast) =>
                toast.id === existing.id
                  ? {
                      ...toast,
                      message: existing.overflow ? message : toast.message,
                      occurrences,
                      overflowEntries: existing.overflow
                        ? previousOverflowEntries
                            .map((entry) =>
                              entry.message === message
                                ? { ...entry, occurrences }
                                : entry,
                            )
                            .slice(-MAX_OVERFLOW_ERROR_KEYS)
                        : toast.overflowEntries,
                    }
                  : toast,
              ),
              pendingAnnouncements: queueAnnouncement(
                state.pendingAnnouncements,
                announcement,
                existing.overflow,
              ),
            };
          }
        }

        const id = crypto.randomUUID();
        scheduledId = id;
        let announcementToastId: string = id;
        let coalesceOverflowAnnouncement = false;
        const toast: Toast = {
          id,
          message,
          type,
          duration: effectiveDuration,
          occurrences: type === "error" ? 1 : undefined,
        };
        let toasts = state.toasts;
        if (
          type === "error" &&
          toasts.filter((item) => item.type === "error" && !item.overflow)
            .length >= MAX_VISIBLE_ERROR_TOASTS
        ) {
          const evict = toasts.find(
            (item) =>
              item.type === "error" &&
              !item.overflow &&
              !toastPauseReasons.get(item.id)?.has("focus"),
          );
          if (evict) {
            clearToastTimer(evict.id);
            toastRemainingMs.delete(evict.id);
            toastPauseReasons.delete(evict.id);
            toasts = toasts.filter((item) => item.id !== evict.id);
          } else {
            const overflow = toasts.find(
              (item) => item.type === "error" && item.overflow,
            );
            if (overflow) {
              announcementToastId = overflow.id;
              coalesceOverflowAnnouncement = true;
              scheduledId = null;
              toasts = toasts.map((item) =>
                item.id === overflow.id
                  ? {
                      ...item,
                      message,
                      occurrences: 1,
                      overflowCount: (item.overflowCount ?? 1) + 1,
                      overflowEntries: [
                        ...(item.overflowEntries ?? [
                          {
                            message: item.message,
                            occurrences: item.occurrences ?? 1,
                          },
                        ]),
                        { message, occurrences: 1 },
                      ].slice(-MAX_OVERFLOW_ERROR_KEYS),
                    }
                  : item,
              );
            } else {
              toast.overflow = true;
              coalesceOverflowAnnouncement = true;
              toast.overflowCount = 1;
              toast.overflowEntries = [{ message, occurrences: 1 }];
            }
          }
        }

        const announcement: ToastAnnouncement = {
          id: crypto.randomUUID(),
          toastId: announcementToastId,
          message,
          type,
          dedupeKey: type === "error" ? message : undefined,
        };
        return {
          toasts: scheduledId ? [...toasts, toast] : toasts,
          pendingAnnouncements: queueAnnouncement(
            state.pendingAnnouncements,
            announcement,
            coalesceOverflowAnnouncement,
          ),
        };
      });
      showNextAnnouncement();

      if (scheduledId) scheduleToastRemoval(scheduledId, effectiveDuration);
    },
    // Manual dismissal also removes any announcement tied to the toast.
    removeToast: (id) => {
      clearToastTimer(id);
      toastRemainingMs.delete(id);
      toastPauseReasons.delete(id);
      set((state) => ({
        toasts: state.toasts.filter((toast) => toast.id !== id),
        currentAnnouncement:
          state.currentAnnouncement?.toastId === id
            ? null
            : state.currentAnnouncement,
        pendingAnnouncements: state.pendingAnnouncements.filter(
          (announcement) => announcement.toastId !== id,
        ),
      }));
    },
    pauseToast: (id, reason) => {
      const reasons = toastPauseReasons.get(id) ?? new Set<string>();
      if (reasons.has(reason)) return;
      reasons.add(reason);
      toastPauseReasons.set(id, reasons);
      if (reasons.size > 1 || !toastTimers.has(id)) return;

      const elapsedMs =
        Date.now() - (toastTimeoutStartedAt.get(id) ?? Date.now());
      const remainingMs = Math.max(
        0,
        (toastRemainingMs.get(id) ?? 0) - elapsedMs,
      );
      clearToastTimer(id);
      toastRemainingMs.set(id, remainingMs);
    },
    resumeToast: (id, reason) => {
      const reasons = toastPauseReasons.get(id);
      if (!reasons) return;
      reasons.delete(reason);
      if (reasons.size > 0) return;
      toastPauseReasons.delete(id);
      const remainingMs = toastRemainingMs.get(id);
      if (remainingMs === undefined) return;
      if (remainingMs === 0) {
        // Expired while paused: the toast goes, but its announcement still plays.
        toastRemainingMs.delete(id);
        set((state) => ({
          toasts: state.toasts.filter((toast) => toast.id !== id),
        }));
        return;
      }
      scheduleToastRemoval(id, remainingMs);
    },
  };
});
