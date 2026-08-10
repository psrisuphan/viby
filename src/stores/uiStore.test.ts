import { beforeEach, describe, expect, it } from "vitest";
import { useUiStore } from "./uiStore";

describe("right-panel state", () => {
	beforeEach(() => {
		useUiStore.setState({ isQueueOpen: false, isTrackDetailsOpen: false });
	});

	it("closes track details when opening the queue", () => {
		useUiStore.getState().setTrackDetailsOpen(true);
		useUiStore.getState().setQueueOpen(true);

		expect(useUiStore.getState().isQueueOpen).toBe(true);
		expect(useUiStore.getState().isTrackDetailsOpen).toBe(false);
	});

	it("closes the queue when opening track details", () => {
		useUiStore.getState().setQueueOpen(true);
		useUiStore.getState().setTrackDetailsOpen(true);

		expect(useUiStore.getState().isQueueOpen).toBe(false);
		expect(useUiStore.getState().isTrackDetailsOpen).toBe(true);
	});
});
