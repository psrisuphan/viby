import { describe, expect, it } from "vitest";
import { getWrappedTabTarget } from "./dialogFocus";

describe("dialog focus wrapping", () => {
  const elements = ["first", "middle", "last"];

  it("wraps Tab from the last control to the first", () => {
    expect(getWrappedTabTarget(elements, "last", false)).toBe("first");
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    expect(getWrappedTabTarget(elements, "first", true)).toBe("last");
  });

  it("pulls focus into the dialog if it escaped", () => {
    expect(getWrappedTabTarget(elements, "outside", false)).toBe("first");
    expect(getWrappedTabTarget(elements, "outside", true)).toBe("last");
  });

  it("leaves Tab navigation alone within the dialog", () => {
    expect(getWrappedTabTarget(elements, "middle", false)).toBeNull();
  });
});
