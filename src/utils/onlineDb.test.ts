import { describe, expect, it } from "vitest";
import { readBoundedResponse } from "./onlineDb";

describe("readBoundedResponse", () => {
  it("returns bounded content and rejects oversized streams", async () => {
    await expect(readBoundedResponse(new Response("curve-data"), 32)).resolves.toBe("curve-data");
    await expect(readBoundedResponse(new Response("too-large"), 4)).rejects.toThrow("50 MB");
  });
});
