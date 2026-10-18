import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../stores/toastStore";
import {
	notifyActionFailure,
	runActionWithFeedback,
	runWindowModeExit,
} from "./actionFeedback";

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
			duration: 0,
		});
	});

	it("uses a readable fallback for an unknown rejection", () => {
		notifyActionFailure(undefined, "Couldn't update the setting.");

		expect(useToastStore.getState().toasts[0].message).toBe("Couldn't update the setting.");
	});

	it("labels global fallback feedback as unexpected", () => {
		notifyActionFailure(undefined, "An unexpected error occurred.");

		expect(useToastStore.getState().toasts[0]).toMatchObject({
			message: "An unexpected error occurred.",
			type: "error",
			duration: 0,
		});
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

	it("announces queue success only after the queue call resolves", async () => {
		let resolveQueue!: () => void;
		const queueTrack = vi.fn(() => new Promise<void>((resolve) => {
			resolveQueue = resolve;
		}));

		const action = runActionWithFeedback(() => queueTrack(), {
			failureMessage: "Couldn't add this song to the queue.",
			successMessage: "Added this song to the queue.",
		});

		expect(queueTrack).toHaveBeenCalledOnce();
		expect(useToastStore.getState().toasts).toEqual([]);

		resolveQueue();
		await action;

		expect(useToastStore.getState().toasts.map(({ message, type }) => ({ message, type }))).toEqual([
			{ message: "Added this song to the queue.", type: "success" },
		]);
	});

	it("restores mini and theater windows after mode-exit failures", async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		const nodeProcess = (globalThis as unknown as {
			process: {
				on: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
				off: (event: "unhandledRejection", listener: (reason: unknown) => void) => void;
			};
		}).process;
		const miniStates: boolean[] = [];
		const theaterStates: boolean[] = [];
		nodeProcess.on("unhandledRejection", onUnhandled);

		try {
			await runWindowModeExit(
				(exiting) => miniStates.push(exiting),
				() => Promise.reject(new Error("Native mini window failed")),
				"Couldn't return from the mini player.",
				0,
			);
			await runWindowModeExit(
				(exiting) => theaterStates.push(exiting),
				() => Promise.reject(new Error("Native theater window failed")),
				"Couldn't leave theater mode.",
				0,
			);
			await new Promise((resolve) => setTimeout(resolve, 0));
		} finally {
			nodeProcess.off("unhandledRejection", onUnhandled);
		}

		expect(miniStates).toEqual([true, false]);
		expect(theaterStates).toEqual([true, false]);
		expect(unhandled).toEqual([]);
		expect(useToastStore.getState().toasts.map(({ type }) => type)).toEqual([
			"error",
			"error",
		]);
		expect(useToastStore.getState().toasts.map(({ message }) => message)).toEqual([
			"Couldn't return from the mini player. Native mini window failed",
			"Couldn't leave theater mode. Native theater window failed",
		]);
	});
});
