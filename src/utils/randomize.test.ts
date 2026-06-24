import { afterEach, describe, expect, it, vi } from "vitest";
import { sample, shuffled } from "./randomize";

describe("randomize", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shuffles without losing items", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		const result = shuffled([1, 2, 3]);
		expect(result).toEqual([2, 3, 1]);
		expect(result.sort()).toEqual([1, 2, 3]);
	});

	it("samples only the requested count", () => {
		vi.spyOn(Math, "random").mockReturnValue(0);
		expect(sample([1, 2, 3, 4], 2)).toEqual([1, 2]);
	});
});
