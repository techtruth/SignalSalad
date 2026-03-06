/**
 * Shared in-memory diagnostics buffer utilities.
 */
import type { SystemDiagnosticEvent } from "../../../types/wsRelay.d.ts";

/** Upper bound for retained in-memory diagnostics history. */
const MAX_RECENT_DIAGNOSTICS = 500;

/**
 * Appends a diagnostic event and enforces bounded in-memory history.
 *
 * The newest event is always retained. Once the cap is reached, the oldest
 * entry is dropped to maintain a fixed memory envelope.
 *
 * @param diagnosticsRecent Mutable diagnostics ring-like array.
 * @param event Diagnostic payload without timestamp.
 * @returns `void`.
 */
export const appendDiagnostic = (
  diagnosticsRecent: SystemDiagnosticEvent[],
  event: Omit<SystemDiagnosticEvent, "at">,
) => {
  diagnosticsRecent.push({
    at: new Date().toISOString(),
    ...event,
  });
  if (diagnosticsRecent.length > MAX_RECENT_DIAGNOSTICS) {
    diagnosticsRecent.shift();
  }
};

/**
 * Returns a defensive snapshot of diagnostics.
 *
 * Callers receive an array copy to avoid mutating reporter-owned state.
 *
 * @param diagnosticsRecent Source diagnostics array.
 * @returns Copy of diagnostics array.
 */
export const getRecentDiagnosticsSnapshot = (
  diagnosticsRecent: SystemDiagnosticEvent[],
) => diagnosticsRecent.slice();
