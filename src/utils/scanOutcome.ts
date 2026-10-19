import type { ScanProgress, ScanRootOutcome } from "../types";

export interface ScanProgressPresentation {
  percent: number;
  isActive: boolean;
  statusText: string;
  error: string | null;
  completionNotice: string | null;
  shouldRefreshLibrary: boolean;
}

export function presentScanProgress(
  progress: ScanProgress,
): ScanProgressPresentation {
  const isActive =
    progress.status === "scanning" || progress.status === "processing";
  const percent =
    progress.total_files > 0
      ? Math.min(100, (progress.processed_files / progress.total_files) * 100)
      : 0;
  const rootOutcomes = progress.root_outcomes ?? [];
  const rootSkippedFiles = rootOutcomes.reduce(countSkippedFiles, 0);
  const skippedFiles = Math.max(
    0,
    progress.skipped_files ?? 0,
    rootSkippedFiles,
  );
  const failedRoots = rootOutcomes.filter(
    (root) => root.status === "error",
  ).length;
  const partialRoots = rootOutcomes.filter(
    (root) => root.status === "partial",
  ).length;
  const abortedRoots = rootOutcomes.filter(
    (root) => root.status === "aborted",
  ).length;
  const failedFolders = Math.max(0, progress.failed_folders ?? 0, failedRoots);
  const issueCounts = [
    skippedFiles > 0 &&
      `${skippedFiles} ${skippedFiles === 1 ? "file" : "files"} skipped`,
    failedFolders > 0 &&
      `${failedFolders} ${failedFolders === 1 ? "folder" : "folders"} failed`,
    partialRoots > 0 &&
      `${partialRoots} root${partialRoots === 1 ? "" : "s"} partially scanned`,
    abortedRoots > 0 &&
      (abortedRoots === 1
        ? "1 root scan aborted"
        : `${abortedRoots} roots aborted`),
  ].filter((count): count is string => Boolean(count));
  const issueDetailsByPath = new Map<string, string>();
  for (const root of rootOutcomes) {
    if (root.status === "complete") continue;
    const rootDetail = root.error?.trim() || rootStatusDetail(root);
    issueDetailsByPath.set(root.path, `${root.path}: ${rootDetail}`);
  }
  for (const issue of [
    ...(progress.folder_errors ?? []),
    ...(progress.file_errors ?? []),
  ]) {
    if (!issueDetailsByPath.has(issue.path)) {
      issueDetailsByPath.set(
        issue.path,
        issue.error.trim()
          ? `${issue.path}: ${issue.error.trim()}`
          : issue.path,
      );
    }
  }
  const allIssueDetails = [...issueDetailsByPath.values()];
  const issueDetails = allIssueDetails.slice(0, 2);
  const hasOmittedDetails =
    progress.error_details_truncated === true ||
    progress.root_outcomes_truncated === true ||
    allIssueDetails.length > issueDetails.length;
  const hasIssues = issueCounts.length > 0 || allIssueDetails.length > 0;
  const issueCountSummary = issueCounts.length
    ? `: ${issueCounts.join(" and ")}`
    : "";
  const issueDetailSummary = issueDetails.length
    ? ` Details: ${issueDetails.join("; ")}.${
        hasOmittedDetails ? " Some details were omitted." : ""
      }`
    : hasOmittedDetails
      ? " Some details were omitted."
      : "";
  const partialScanNotice =
    progress.status === "complete" &&
    (progress.partial_success === true || hasIssues)
      ? `Scan completed with issues${issueCountSummary}.${issueDetailSummary}`
      : null;
  const errorMessage =
    progress.error?.trim() ||
    progress.message?.trim() ||
    "Library scan failed.";
  const error =
    progress.status === "error"
      ? `${errorMessage}${
          hasIssues
            ? `. Scan issues${issueCountSummary}.${issueDetailSummary}`
            : ""
        }`
      : null;
  const completionNotice =
    partialScanNotice ??
    (progress.status === "complete" ? progress.message?.trim() || null : null);
  const statusText = isActive
    ? `Scanning ${progress.processed_files.toLocaleString()} / ${progress.total_files.toLocaleString()} files`
    : error
      ? "Library scan failed."
      : (completionNotice ?? "Library scan complete.");
  const hasChanges =
    (progress.new_tracks ?? 0) > 0 ||
    (progress.changed_tracks ?? 0) > 0 ||
    (progress.removed_tracks ?? 0) > 0;

  return {
    percent,
    isActive,
    statusText,
    error,
    completionNotice,
    shouldRefreshLibrary:
      (progress.status === "complete" || progress.status === "error") &&
      hasChanges,
  };
}

function countSkippedFiles(total: number, root: ScanRootOutcome): number {
  return total + Math.max(0, root.skipped_files ?? 0);
}

function rootStatusDetail(root: ScanRootOutcome): string {
  if (root.status === "partial") {
    const skipped =
      root.skipped_files > 0
        ? `${root.skipped_files} ${root.skipped_files === 1 ? "file" : "files"} skipped`
        : "partial results";
    return root.pruning_skipped ? `${skipped}; pruning skipped` : skipped;
  }
  return root.status === "error" ? "folder scan failed" : "scan aborted";
}
