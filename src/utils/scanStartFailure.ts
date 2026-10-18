import { formatInvokeError } from "./errorMessage";

/**
 * A scan that starts always ends with a terminal scan-progress event, and the app-level scan
 * status announces it. A rejection from a scan that never started has no such event: either
 * another scan holds the lock (`ScanBusy`) or the IPC call itself failed. Only those need a
 * message from the caller.
 */
export function isScanStartFailure(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return true;
	const kind = (error as { kind?: unknown }).kind;
	return kind === "ScanBusy" || typeof kind !== "string";
}

export function describeScanStartFailure(error: unknown): string {
	return formatInvokeError(error, "Couldn't start the library scan.");
}
