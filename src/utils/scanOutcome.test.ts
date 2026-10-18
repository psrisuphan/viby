import { describe, expect, it } from "vitest";
import type { ScanProgress } from "../types";
import { presentScanProgress } from "./scanOutcome";

const progress = (
	values: Partial<ScanProgress> & Pick<ScanProgress, "status">,
): ScanProgress => ({
	total_files: 0,
	processed_files: 0,
	current_file: "",
	...values,
});

describe("presentScanProgress", () => {
	it("shows a non-blocking file count while a scan is active", () => {
		expect(
			presentScanProgress(
				progress({ status: "scanning", total_files: 20, processed_files: 5 }),
			),
		).toMatchObject({
			percent: 25,
			isActive: true,
			statusText: "Scanning 5 / 20 files",
			error: null,
			partialNotice: null,
			shouldRefreshLibrary: false,
		});
	});

	it("distinguishes a partial completion and requests a usable library refresh", () => {
		expect(
			presentScanProgress(
				progress({
					status: "complete",
					processed_files: 8,
					total_files: 8,
					new_tracks: 2,
					skipped_files: 3,
					failed_folders: 1,
					partial_success: true,
				}),
			),
		).toEqual({
			percent: 100,
			isActive: false,
			statusText: "Scan completed with issues: 3 files skipped and 1 folder failed.",
			error: null,
			partialNotice: "Scan completed with issues: 3 files skipped and 1 folder failed.",
			shouldRefreshLibrary: true,
		});
	});

	it("preserves fatal scan details and refreshes any reported usable changes", () => {
		expect(
			presentScanProgress(
				progress({
					status: "error",
					error: "Database write failed",
					new_tracks: 1,
				}),
			),
		).toMatchObject({
			isActive: false,
			statusText: "Library scan failed.",
			error: "Database write failed",
			partialNotice: null,
			shouldRefreshLibrary: true,
		});
	});

	it("uses a fallback for old or incomplete fatal payloads", () => {
		expect(
			presentScanProgress(progress({ status: "error" })),
		).toMatchObject({
			error: "Library scan failed.",
			statusText: "Library scan failed.",
		});
	});
});
