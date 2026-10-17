import { describe, expect, it } from "vitest";
import { getSliderKeyboardValue, normalizeSliderValue } from "./sliderMath";

describe("accessible slider math", () => {
	it("clamps and snaps pointer values to the configured step", () => {
		expect(normalizeSliderValue(1.26, 0, 1, 0.1)).toBe(1);
		expect(normalizeSliderValue(0.26, 0, 1, 0.1)).toBe(0.3);
	});

	it("supports arrow, page, and endpoint keys", () => {
		expect(getSliderKeyboardValue("ArrowUp", 0, -12, 12, 0.1, 1.2)).toBe(0.1);
		expect(getSliderKeyboardValue("PageDown", 0, -12, 12, 0.1, 1.2)).toBe(-1.2);
		expect(getSliderKeyboardValue("Home", 0, -12, 12, 0.1, 1.2)).toBe(-12);
		expect(getSliderKeyboardValue("End", 0, -12, 12, 0.1, 1.2)).toBe(12);
		expect(getSliderKeyboardValue("Enter", 0, -12, 12, 0.1, 1.2)).toBeNull();
	});
});
