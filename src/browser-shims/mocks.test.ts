import { beforeEach, describe, expect, it } from "vitest";
import { applyMockPlaybackCommand, mockPlaybackState } from "./mocks";

describe("browser playback command mocks", () => {
	beforeEach(() => {
		mockPlaybackState.volume = 0.8;
		mockPlaybackState.is_muted = false;
		mockPlaybackState.previous_volume = 0.8;
		mockPlaybackState.shuffle = false;
		mockPlaybackState.repeat_mode = "off";
	});

	it("applies volume and mute commands in command order", () => {
		applyMockPlaybackCommand("set_volume", { volume: 0.4 });
		applyMockPlaybackCommand("toggle_mute");
		applyMockPlaybackCommand("toggle_mute");

		expect(mockPlaybackState.volume).toBe(0.4);
		expect(mockPlaybackState.previous_volume).toBe(0.4);
		expect(mockPlaybackState.is_muted).toBe(false);
	});

	it("updates shuffle and repeat control snapshots", () => {
		applyMockPlaybackCommand("toggle_shuffle");
		applyMockPlaybackCommand("cycle_repeat");

		expect(mockPlaybackState.shuffle).toBe(true);
		expect(mockPlaybackState.repeat_mode).toBe("all");
	});
});
