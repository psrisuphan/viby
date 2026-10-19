import { formatInvokeError } from "./errorMessage";

const TERMINAL_SCAN_ERROR_KINDS = new Set([
  "Database",
  "Audio",
  "NotFound",
  "Io",
  "Other",
]);

/**
 * A scan that starts emits its terminal status before returning a known AppError kind. `ScanBusy`
 * is returned before the scan starts; untyped and unknown typed failures can also be IPC or
 * transport failures that never emit a terminal event. Only those need a message from the caller.
 */
export function isScanStartFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return true;
  const kind = (error as { kind?: unknown }).kind;
  return (
    kind === "ScanBusy" ||
    typeof kind !== "string" ||
    !TERMINAL_SCAN_ERROR_KINDS.has(kind)
  );
}

export function describeScanStartFailure(error: unknown): string {
  return formatInvokeError(error, "Couldn't start the library scan.");
}
