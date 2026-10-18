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
					processed_files: 3,
					total_files: 3,
					new_tracks: 1,
					skipped_files: 1,
					failed_folders: 1,
					partial_success: true,
					folder_errors: [
						{ path: "/offline/music", error: "unavailable root" },
					],
					file_errors: [
						{ path: "/music/bad.mp3", error: "unsupported file" },
					],
				}),
			),
		).toEqual({
			percent: 100,
			isActive: false,
			statusText:
				"Scan completed with issues: 1 file skipped and 1 folder failed. Details: /offline/music: unavailable root; /music/bad.mp3: unsupported file.",
			error: null,
			completionNotice:
				"Scan completed with issues: 1 file skipped and 1 folder failed. Details: /offline/music: unavailable root; /music/bad.mp3: unsupported file.",
			shouldRefreshLibrary: true,
		});
	});

	it("caps issue details and marks when the scan summary omits the rest", () => {
		expect(
			presentScanProgress(
				progress({
					status: "complete",
					partial_success: true,
					skipped_files: 101,
					failed_folders: 2,
					folder_errors: [
						{ path: "/offline/a", error: "Unavailable" },
					],
					file_errors: [
						{ path: "/music/bad.mp3", error: "Unreadable" },
						{ path: "/music/also-bad.mp3", error: "Unreadable" },
					],
					error_details_truncated: true,
				}),
			),
		).toMatchObject({
			completionNotice:
				"Scan completed with issues: 101 files skipped and 2 folders failed. Details: /offline/a: Unavailable; /music/bad.mp3: Unreadable. Some details were omitted.",
			shouldRefreshLibrary: false,
		});
	});

	it("summarizes bounded root outcomes without repeating folder errors", () => {
		expect(
			presentScanProgress(
				progress({
					status: "complete",
					partial_success: true,
					skipped_files: 1,
					failed_folders: 1,
					root_outcomes: [
						{
							path: "/offline/music",
							status: "error",
							discovered_files: 0,
							skipped_files: 0,
							protected_empty_subtrees: 0,
							pruning_skipped: true,
							error: "unavailable root",
						},
						{
							path: "/music",
							status: "partial",
							discovered_files: 2,
							skipped_files: 1,
							protected_empty_subtrees: 0,
							pruning_skipped: true,
							error:
								"1 file(s) failed metadata extraction; stale tracks were retained for this root",
						},
					],
					root_outcomes_truncated: true,
					folder_errors: [
						{ path: "/offline/music", error: "unavailable root" },
					],
					file_errors: [
						{ path: "/music/bad.mp3", error: "unsupported file" },
					],
				}),
			),
		).toMatchObject({
			completionNotice:
				"Scan completed with issues: 1 file skipped and 1 folder failed and 1 root partially scanned. Details: /offline/music: unavailable root; /music: 1 file(s) failed metadata extraction; stale tracks were retained for this root. Some details were omitted.",
			shouldRefreshLibrary: false,
		});
	});

	it("shows an emitted prune error and refreshes its committed track", () => {
		expect(
			presentScanProgress(
				progress({
					status: "error",
					error: "Database pruning failed",
					new_tracks: 1,
					partial_success: false,
					root_outcomes: [
						{
							path: "/music",
							status: "aborted",
							discovered_files: 1,
							skipped_files: 0,
							protected_empty_subtrees: 0,
							pruning_skipped: true,
							error: "Database pruning failed",
						},
					],
				}),
			),
		).toMatchObject({
			isActive: false,
			statusText: "Library scan failed.",
			error:
				"Database pruning failed. Scan issues: 1 root scan aborted. Details: /music: Database pruning failed.",
			completionNotice: null,
			shouldRefreshLibrary: true,
		});
	});

	it("shows the emitted error's skipped-folder summary and capped details", () => {
		expect(
			presentScanProgress(
				progress({
					status: "error",
					error: "database read failed",
					new_tracks: 1,
					failed_folders: 1,
					folder_errors: [
						{ path: "/offline/music", error: "unavailable root" },
					],
				}),
			),
		).toMatchObject({
			isActive: false,
			statusText: "Library scan failed.",
			error:
				"database read failed. Scan issues: 1 folder failed. Details: /offline/music: unavailable root.",
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
