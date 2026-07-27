import { describe, expect, it } from "vitest";
import { resizeFromFixedTopLeft } from "./windowResize";

describe("resizeFromFixedTopLeft", () => {
	it("resizes supported edges and enforces the minimum size", () => {
		expect(resizeFromFixedTopLeft("East", 1000, 700, 100, 100, 960, 680)).toEqual({ width: 1100, height: 700 });
		expect(resizeFromFixedTopLeft("South", 1000, 700, 100, 100, 960, 680)).toEqual({ width: 1000, height: 800 });
		expect(resizeFromFixedTopLeft("SouthEast", 1000, 700, -100, -100, 960, 680)).toEqual({ width: 960, height: 680 });
	});
});
