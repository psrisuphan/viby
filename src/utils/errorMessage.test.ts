import { describe, expect, it } from "vitest";
import { formatInvokeError } from "./errorMessage";

describe("formatInvokeError", () => {
	it("formats structured Tauri errors without showing Object object", () => {
		expect(
			formatInvokeError(
				{ kind: "Io", message: "Permission denied" },
				"Scan failed",
			),
		).toBe("IO error: Permission denied");
	});

	it("formats unit errors such as a busy scan", () => {
		expect(formatInvokeError({ kind: "ScanBusy" }, "Scan failed")).toBe(
			"Scan already in progress",
		);
	});

	it("keeps string and Error messages", () => {
		expect(formatInvokeError("Permission denied", "Scan failed")).toBe(
			"Permission denied",
		);
		expect(formatInvokeError(new Error("Disk unavailable"), "Scan failed")).toBe(
			"Disk unavailable",
		);
	});

	it("uses the fallback for empty or unknown failures", () => {
		expect(formatInvokeError({}, "Scan failed")).toBe("Scan failed");
		expect(formatInvokeError(null, "Scan failed")).toBe("Scan failed");
	});
});
