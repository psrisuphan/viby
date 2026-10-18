import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../stores/toastStore";
import { notifyActionFailure, runActionWithFeedback } from "./actionFeedback";

describe("action failure feedback", () => {
	beforeEach(() => useToastStore.setState({ toasts: [], currentAnnouncement: null, pendingAnnouncements: [] }));

	afterEach(() => {
		for (const toast of useToastStore.getState().toasts) {
			useToastStore.getState().removeToast(toast.id);
		}
		useToastStore.setState({ currentAnnouncement: null, pendingAnnouncements: [] });
	});

	it("shows an actionable error message for a rejected action", () => {
		notifyActionFailure(new Error("Playback device is unavailable"), "Couldn't start playback.");

		expect(useToastStore.getState().toasts[0]).toMatchObject({
			message: "Couldn't start playback. Playback device is unavailable",
			type: "error",
			duration: 7000,
		});
	});

	it("uses a readable fallback for an unknown rejection", () => {
		notifyActionFailure(undefined, "Couldn't update the setting.");

		expect(useToastStore.getState().toasts[0].message).toBe("Couldn't update the setting.");
	});

	it("catches rejected play and queue actions without success toasts or unhandled rejections", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		const nodeProcess = (globalThis as unknown as {
			process: {
				on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
				off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
			};
		}).process;
		const rejectedPlay = vi.fn().mockRejectedValue(new Error("Audio device unavailable"));
		const rejectedQueue = vi.fn().mockRejectedValue(new Error("Queue is unavailable"));
		nodeProcess.on("unhandledRejection", onUnhandled);

		try {
			await runActionWithFeedback(() => rejectedPlay("track-1"), {
				failureMessage: "Couldn't start playback.",
			});
			await runActionWithFeedback(() => rejectedQueue("track-1"), {
				failureMessage: "Couldn't add this song to the queue.",
				successMessage: "Added this song to the queue.",
			});
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			nodeProcess.off("unhandledRejection", onUnhandled);
		}

		expect(rejectedPlay).toHaveBeenCalledWith("track-1");
		expect(rejectedQueue).toHaveBeenCalledWith("track-1");
		expect(unhandled).toEqual([]);
		expect(useToastStore.getState().toasts.map((toast) => toast.type)).toEqual([
			"error",
			"error",
		]);
		expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
			"Couldn't start playback. Audio device unavailable",
			"Couldn't add this song to the queue. Queue is unavailable",
		]);
	});
});
