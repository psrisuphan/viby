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
			completionNotice: null,
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
					folder_errors: [
						{ path: "/music/offline", error: "Folder is unavailable" },
					],
					file_errors: [
						{ path: "/music/bad.mp3", error: "File could not be read" },
					],
				}),
			),
		).toEqual({
			percent: 100,
			isActive: false,
			statusText:
				"Scan completed with issues: 3 files skipped and 1 folder failed. Details: /music/offline: Folder is unavailable; /music/bad.mp3: File could not be read.",
			error: null,
			completionNotice:
				"Scan completed with issues: 3 files skipped and 1 folder failed. Details: /music/offline: Folder is unavailable; /music/bad.mp3: File could not be read.",
			shouldRefreshLibrary: true,
		});
	});

	it("marks when the scan summary omits failure details", () => {
		expect(
			presentScanProgress(
				progress({
					status: "complete",
					partial_success: true,
					skipped_files: 101,
					failed_folders: 2,
					file_errors: [{ path: "/music/bad.mp3", error: "Unreadable" }],
					error_details_truncated: true,
				}),
			),
		).toMatchObject({
			completionNotice:
				"Scan completed with issues: 101 files skipped and 2 folders failed. Details: /music/bad.mp3: Unreadable. Some details were omitted.",
			shouldRefreshLibrary: false,
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
			completionNotice: null,
			shouldRefreshLibrary: true,
		});
	});

	it("refreshes terminal errors when the scan committed changed tracks", () => {
		expect(
			presentScanProgress(
				progress({
					status: "error",
					error: "Database pruning failed",
					changed_tracks: 2,
				}),
			),
		).toMatchObject({
			error: "Database pruning failed",
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

	it("shows terminal backend messages when no folders are configured", () => {
		expect(
			presentScanProgress(
				progress({
					status: "complete",
					message: "No library folders configured. Add a folder first.",
					total_tracks: 0,
				}),
			),
		).toMatchObject({
			statusText: "No library folders configured. Add a folder first.",
			completionNotice: "No library folders configured. Add a folder first.",
			shouldRefreshLibrary: false,
		});
	});
});
