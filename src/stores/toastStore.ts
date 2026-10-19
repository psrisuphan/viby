import { create } from 'zustand';

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const toastRemainingMs = new Map<string, number>();
const toastTimeoutStartedAt = new Map<string, number>();
const toastPauseReasons = new Map<string, Set<string>>();
const MAX_VISIBLE_ERROR_TOASTS = 5;

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
  type: 'info' | 'success' | 'error';
  duration?: number;
  occurrences?: number;
}

export interface ToastAnnouncement {
  id: string;
  toastId: string;
  message: string;
  type: Toast['type'];
}

interface ToastState {
  toasts: Toast[];
	currentAnnouncement: ToastAnnouncement | null;
	pendingAnnouncements: ToastAnnouncement[];
  addToast: (message: string, type?: Toast['type'], duration?: number) => void;
  removeToast: (id: string) => void;
  pauseToast: (id: string, reason: string) => void;
  resumeToast: (id: string, reason: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => {
	let announcementTimer: ReturnType<typeof setTimeout> | null = null;
	let store: ToastState;

	const scheduleToastRemoval = (id: string, delayMs: number) => {
		if (delayMs <= 0) return;
		toastRemainingMs.set(id, delayMs);
		toastTimeoutStartedAt.set(id, Date.now());
		toastTimers.set(id, setTimeout(() => {
			toastTimers.delete(id);
			toastTimeoutStartedAt.delete(id);
			toastRemainingMs.delete(id);
			toastPauseReasons.delete(id);
			set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
		}, delayMs));
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
	) => {
		const existingIndex = pending.findIndex(
			(item) => item.toastId === announcement.toastId,
		);
		if (existingIndex < 0) return [...pending, announcement];
		return pending.map((item, index) =>
			index === existingIndex ? announcement : item,
		);
	};

	store = {
		toasts: [],
		currentAnnouncement: null,
		pendingAnnouncements: [],
		addToast: (message, type = 'info', duration) => {
			const effectiveDuration = type === 'error' ? 0 : duration ?? 3000;
			let scheduledId: string | null = null;
			set((state) => {
				if (type === 'error') {
					const existing = state.toasts.find(
						(toast) => toast.type === 'error' && toast.message === message,
					);
					if (existing) {
						const occurrences = (existing.occurrences ?? 1) + 1;
						const announcement: ToastAnnouncement = {
							id: crypto.randomUUID(),
							toastId: existing.id,
							message: `${message} (repeated ${occurrences} times)`,
							type,
						};
						return {
							toasts: state.toasts.map((toast) =>
								toast.id === existing.id ? { ...toast, occurrences } : toast,
							),
							pendingAnnouncements: queueAnnouncement(
								state.pendingAnnouncements,
								announcement,
							),
						};
					}
				}

				const id = crypto.randomUUID();
				scheduledId = id;
				const toast: Toast = {
					id,
					message,
					type,
					duration: effectiveDuration,
					occurrences: type === 'error' ? 1 : undefined,
				};
				let toasts = state.toasts;
				if (
					type === 'error' &&
					toasts.filter((item) => item.type === 'error').length >= MAX_VISIBLE_ERROR_TOASTS
				) {
					const evict = toasts.find(
						(item) =>
							item.type === 'error' &&
							!toastPauseReasons.get(item.id)?.has('focus'),
					);
					if (evict) {
						clearToastTimer(evict.id);
						toastRemainingMs.delete(evict.id);
						toastPauseReasons.delete(evict.id);
						toasts = toasts.filter((item) => item.id !== evict.id);
					} else {
						scheduledId = null;
					}
				}

				const announcement: ToastAnnouncement = {
					id: crypto.randomUUID(),
					toastId: id,
					message,
					type,
				};
				return {
					toasts: scheduledId ? [...toasts, toast] : toasts,
					pendingAnnouncements: queueAnnouncement(
						state.pendingAnnouncements,
						announcement,
					),
				};
			});
			showNextAnnouncement();

			if (scheduledId) scheduleToastRemoval(scheduledId, effectiveDuration);
		},
		// Manual dismissal. Also drops the toast's announcement if it has not been read yet.
		removeToast: (id) => {
			clearToastTimer(id);
			toastRemainingMs.delete(id);
			toastPauseReasons.delete(id);
			set((state) => ({
				toasts: state.toasts.filter((t) => t.id !== id),
				currentAnnouncement:
					state.currentAnnouncement?.toastId === id
						? null
						: state.currentAnnouncement,
				pendingAnnouncements: state.pendingAnnouncements.filter((a) => a.toastId !== id),
			}));
		},
		pauseToast: (id, reason) => {
			const reasons = toastPauseReasons.get(id) ?? new Set<string>();
			if (reasons.has(reason)) return;
			reasons.add(reason);
			toastPauseReasons.set(id, reasons);
			if (reasons.size > 1 || !toastTimers.has(id)) return;

			const elapsedMs = Date.now() - (toastTimeoutStartedAt.get(id) ?? Date.now());
			const remainingMs = Math.max(0, (toastRemainingMs.get(id) ?? 0) - elapsedMs);
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
					toasts: state.toasts.filter((t) => t.id !== id),
				}));
				return;
			}
			scheduleToastRemoval(id, remainingMs);
		},
	};
	return store;
});
