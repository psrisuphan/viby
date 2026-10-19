import { afterEach, describe, expect, it, vi } from "vitest";
import {
	isPlaybackDebugEnabled,
	logPlaybackDebug,
	shouldEnablePlaybackDebug,
} from "./debug";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("playback debug logging", () => {
	it("is enabled in development or by the explicit local flag", () => {
		expect(shouldEnablePlaybackDebug(true, null)).toBe(true);
		expect(shouldEnablePlaybackDebug(false, "1")).toBe(true);
		expect(shouldEnablePlaybackDebug(false, "0")).toBe(false);
		expect(shouldEnablePlaybackDebug(false, null)).toBe(false);
	});

	it("writes a prefixed event at the requested log level", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const details = { stalled_ms: 1200, has_track: true };

		logPlaybackDebug("warn", "UI event loop stall", details);

		if (import.meta.env.DEV) {
			expect(warn).toHaveBeenCalledWith(
				"[VibyDebug] UI event loop stall",
				details,
			);
		} else {
			expect(warn).not.toHaveBeenCalled();
		}
	});

	it("supports non-browser environments without localStorage", () => {
		expect(typeof isPlaybackDebugEnabled()).toBe("boolean");
	});

	it("keeps production logging disabled when localStorage access throws", () => {
		vi.stubEnv("DEV", false);
		vi.stubGlobal(
			"localStorage",
			new Proxy(
				{},
				{
					get() {
						throw new Error("storage access denied");
					},
				}),
		);

		expect(isPlaybackDebugEnabled()).toBe(false);
	});
});
