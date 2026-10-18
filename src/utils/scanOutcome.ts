import type { ScanProgress } from "../types";

export interface ScanProgressPresentation {
	percent: number;
	isActive: boolean;
	statusText: string;
	error: string | null;
	partialNotice: string | null;
	shouldRefreshLibrary: boolean;
}

export function presentScanProgress(
	progress: ScanProgress,
): ScanProgressPresentation {
	const isActive =
		progress.status === "scanning" || progress.status === "processing";
	const percent =
		progress.total_files > 0
			? Math.min(
					100,
					(progress.processed_files / progress.total_files) * 100,
				)
			: 0;
	const error =
		progress.status === "error"
			? progress.error?.trim() || progress.message?.trim() || "Library scan failed."
			: null;
	const skippedFiles = Math.max(0, progress.skipped_files ?? 0);
	const failedFolders = Math.max(0, progress.failed_folders ?? 0);
	const issueCounts = [
		skippedFiles > 0 && `${skippedFiles} ${skippedFiles === 1 ? "file" : "files"} skipped`,
		failedFolders > 0 && `${failedFolders} ${failedFolders === 1 ? "folder" : "folders"} failed`,
	].filter((count): count is string => Boolean(count));
	const partialNotice =
		progress.status === "complete" && progress.partial_success === true
			? `Scan completed with issues${issueCounts.length ? `: ${issueCounts.join(" and ")}` : ""}.`
			: null;
	const statusText = isActive
		? `Scanning ${progress.processed_files.toLocaleString()} / ${progress.total_files.toLocaleString()} files`
		: error
			? "Library scan failed."
			: partialNotice ?? "Library scan complete.";
	const hasChanges =
		(progress.new_tracks ?? 0) > 0 ||
		(progress.changed_tracks ?? 0) > 0 ||
		(progress.removed_tracks ?? 0) > 0;

	return {
		percent,
		isActive,
		statusText,
		error,
		partialNotice,
		shouldRefreshLibrary:
			(progress.status === "complete" || progress.status === "error") &&
			hasChanges,
	};
}
