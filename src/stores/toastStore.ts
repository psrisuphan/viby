import { create } from 'zustand';

const toastTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearToastTimer(id: string) {
  const timer = toastTimers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    toastTimers.delete(id);
  }
}

export interface Toast {
  id: string;
  message: string;
  type: 'info' | 'success' | 'error';
  duration?: number;
}

export type ToastAnnouncement = Pick<Toast, 'id' | 'message' | 'type'>;

interface ToastState {
  toasts: Toast[];
	currentAnnouncement: ToastAnnouncement | null;
	pendingAnnouncements: ToastAnnouncement[];
  addToast: (message: string, type?: Toast['type'], duration?: number) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set, get) => {
	let announcementTimer: ReturnType<typeof setTimeout> | null = null;

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

	return {
		toasts: [],
		currentAnnouncement: null,
		pendingAnnouncements: [],
		addToast: (message, type = 'info', duration = 3000) => {
			const id = crypto.randomUUID();
			const toast = { id, message, type, duration };
			set((state) => ({
				toasts: [...state.toasts, toast],
				pendingAnnouncements: [
					...state.pendingAnnouncements,
					{ id, message, type },
				],
			}));
			showNextAnnouncement();

			if (duration > 0) {
				toastTimers.set(id, setTimeout(() => {
					toastTimers.delete(id);
					set((state) => ({
						toasts: state.toasts.filter((t) => t.id !== id),
					}));
				}, duration));
			}
		},
		removeToast: (id) => {
			clearToastTimer(id);
			set((state) => ({
				toasts: state.toasts.filter((t) => t.id !== id),
			}));
		},
	};
});
