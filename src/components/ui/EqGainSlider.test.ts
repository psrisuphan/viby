import { describe, expect, it } from "vitest";
import { getVisibleEqDbMarks } from "./EqGainSlider";

describe("EQ gain scale marks", () => {
  it("limits standard marks to a configured range", () => {
    expect(getVisibleEqDbMarks(-6, 6)).toEqual([6, 3, 0, -3, -6]);
    expect(getVisibleEqDbMarks(-2, 2)).toEqual([0]);
    expect(getVisibleEqDbMarks(-12, 12)).toEqual([
      12, 9, 6, 3, 0, -3, -6, -9, -12,
    ]);
  });
});
