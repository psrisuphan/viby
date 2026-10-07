import { describe, expect, it } from "vitest";
import {
  parseCurveDatabase,
  parseManifestData,
  readBoundedResponse,
} from "./onlineDb";

describe("readBoundedResponse", () => {
  it("returns bounded content and rejects oversized streams", async () => {
    await expect(readBoundedResponse(new Response("curve-data"), 32)).resolves.toBe("curve-data");
    await expect(readBoundedResponse(new Response("too-large"), 4)).rejects.toThrow("50 MB");
  });
});

describe("online database validation", () => {
  it("accepts valid curves and ignores malformed entries", () => {
    expect(
      parseCurveDatabase({
        meta: { frequencies: [20, 1000] },
        curves: {
          valid: { d: [1, 2] },
          malformed: { d: [1, "bad"] },
        },
      }),
    ).toEqual({
      meta: { frequencies: [20, 1000] },
      curves: { valid: { d: [1, 2] } },
    });
  });

  it("rejects malformed database and manifest roots", () => {
    expect(() => parseCurveDatabase({ meta: {}, curves: {} })).toThrow(
      "frequencies are missing or invalid",
    );
    expect(() => parseManifestData({})).toThrow("missing measurements");
  });
});
