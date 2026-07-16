const AUTO_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function isAutoScanDue(lastScan: number, now = Date.now()) {
	return (
		!Number.isFinite(lastScan) ||
		lastScan > now ||
		now - lastScan >= AUTO_SCAN_INTERVAL_MS
	);
}
