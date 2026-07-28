import { describe, expect, it } from "vitest";
import { isAutoScanDue } from "./scanCadence";

describe("isAutoScanDue", () => {
	it("skips a fresh profile and runs at most once per day", () => {
		const now = 2 * 24 * 60 * 60 * 1000;
		expect(isAutoScanDue(Number.NaN, now)).toBe(false);
		expect(isAutoScanDue(now + 1000, now)).toBe(true);
		expect(isAutoScanDue(now - 1000, now)).toBe(false);
		expect(isAutoScanDue(now - 24 * 60 * 60 * 1000, now)).toBe(true);
	});
});
