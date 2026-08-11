const ERROR_KIND_LABELS: Record<string, string> = {
	Database: "Database error",
	Audio: "Audio error",
	NotFound: "Not found",
	Io: "IO error",
	ScanBusy: "Scan already in progress",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Convert Tauri command failures into a useful message for the UI. */
export function formatInvokeError(error: unknown, fallback: string): string {
	if (typeof error === "string" && error.trim()) return error;
	if (error instanceof Error && error.message.trim()) return error.message;

	if (isRecord(error)) {
		const kind = typeof error.kind === "string" ? error.kind : "";
		const message = typeof error.message === "string" ? error.message.trim() : "";
		const label = ERROR_KIND_LABELS[kind] ?? kind;

		if (message && kind && kind !== "Other") return `${label}: ${message}`;
		if (message) return message;
		if (label) return label;
	}

	return fallback;
}
