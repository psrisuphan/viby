import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "./toastStore";

describe("toast notifications", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useToastStore.setState({ toasts: [], currentAnnouncement: null, pendingAnnouncements: [] });
	});

	afterEach(() => {
		for (const toast of useToastStore.getState().toasts) {
			useToastStore.getState().removeToast(toast.id);
		}
		useToastStore.setState({ currentAnnouncement: null, pendingAnnouncements: [] });
		vi.runAllTimers();
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it("keeps several notifications visible together", () => {
		useToastStore.getState().addToast("Track queued", "success");
		useToastStore.getState().addToast("Playback failed", "error", 0);

		expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
			"Track queued",
			"Playback failed",
		]);
	});

	it("keeps duration-zero errors until dismissed", () => {
		useToastStore.getState().addToast("Database is unavailable", "error", 0);

		vi.advanceTimersByTime(60_000);
		expect(useToastStore.getState().toasts).toHaveLength(1);

		const [toast] = useToastStore.getState().toasts;
		useToastStore.getState().removeToast(toast.id);
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("removes timed notifications automatically", () => {
		useToastStore.getState().addToast("Saved", "success", 5000);

		vi.advanceTimersByTime(5000);
		expect(useToastStore.getState().toasts).toHaveLength(0);
	});

	it("announces each queued notification once in order when the newest one is dismissed", () => {
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

		useToastStore.getState().addToast("First action succeeded", "success", 1000);
		useToastStore.getState().addToast("Second action failed", "error", 10);
		const [first, second] = useToastStore.getState().toasts;

		expect(useToastStore.getState().currentAnnouncement).toMatchObject({
			id: first.id,
			message: first.message,
			type: first.type,
		});
		expect(useToastStore.getState().pendingAnnouncements).toMatchObject([
			{ id: second.id, message: second.message, type: second.type },
		]);

		useToastStore.getState().removeToast(second.id);
		vi.advanceTimersByTime(1000);
		expect(useToastStore.getState().toasts).toHaveLength(0);
		expect(useToastStore.getState().currentAnnouncement?.message).toBe(first.message);
		expect(useToastStore.getState().pendingAnnouncements).toHaveLength(1);

		vi.advanceTimersByTime(180);
		expect(useToastStore.getState().currentAnnouncement).toMatchObject({
			id: second.id,
			message: second.message,
		});
		expect(useToastStore.getState().pendingAnnouncements).toEqual([]);
		vi.advanceTimersByTime(1180);
		expect(useToastStore.getState().currentAnnouncement).toBeNull();
			unsubscribe();
			expect(announced).toEqual([first.message, second.message]);
	});
});
