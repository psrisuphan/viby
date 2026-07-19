import { describe, expect, it } from "vitest";
import { artworkCacheKey } from "./useArtwork";

describe("artworkCacheKey", () => {
	it("keeps thumbnail, standard, and fullscreen variants separate", () => {
		expect(artworkCacheKey("album||artist", 128)).toBe("album||artist@128");
		expect(artworkCacheKey("album||artist", 384)).toBe("album||artist@384");
		expect(artworkCacheKey("album||artist", 768)).toBe("album||artist@768");
	});
});
