import { beforeEach, describe, expect, it } from "vitest";
import { useToastStore } from "../stores/toastStore";
import { notifyActionFailure } from "./actionFeedback";

describe("action failure feedback", () => {
	beforeEach(() => useToastStore.setState({ toasts: [] }));

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
});
