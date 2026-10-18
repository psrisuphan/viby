import { describe, expect, it } from "vitest";
import { describeScanStartFailure, isScanStartFailure } from "./scanStartFailure";

describe("scan start failures", () => {
	it("reports a busy scan lock, which emits no scan event", () => {
		expect(isScanStartFailure({ kind: "ScanBusy" })).toBe(true);
		expect(describeScanStartFailure({ kind: "ScanBusy" })).toBe("Scan already in progress");
	});

	it("reports IPC transport failures that never reached the scan", () => {
		expect(isScanStartFailure(new Error("IPC channel closed"))).toBe(true);
		expect(isScanStartFailure("Failed to invoke scan_library")).toBe(true);
		expect(describeScanStartFailure(new Error("IPC channel closed"))).toBe("IPC channel closed");
	});

	it("leaves started-scan failures to the app-level scan status", () => {
		for (const kind of ["Database", "Audio", "NotFound", "Io", "Other"]) {
			expect(isScanStartFailure({ kind, message: "boom" })).toBe(false);
		}
	});

	it("falls back to a generic message when the error carries no detail", () => {
		expect(describeScanStartFailure(undefined)).toBe("Couldn't start the library scan.");
	});
});
