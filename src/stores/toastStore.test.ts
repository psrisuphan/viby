import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "./toastStore";

describe("toast notifications", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		useToastStore.setState({ toasts: [] });
	});

	afterEach(() => {
		for (const toast of useToastStore.getState().toasts) {
			useToastStore.getState().removeToast(toast.id);
		}
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
});
