/**
 * @module trace
 * @file Optional controller logging.
 *
 * Purpose:
 * This module provides a **small but complete** diagnostics channel for the
 * controller. It exists to make event ordering, timing, and state transitions
 * visible without changing application behavior.
 *
 * How it works:
 * - Uses a lightweight trace logger (single level).
 * - The level is controlled via localStorage (default: "off").
 * - Each log is prefixed with `mediasoup-session-controller:trace` for easy filtering.
 * - When disabled, logging calls are no‑ops.
 *
 * Controls:
 * - `localStorage.MEDIASOUP_SESSION_CONTROLLER_LOG_LEVEL = "trace" | "off"`
 *
 * Enable trace output in the browser console:
 * ```ts
 * localStorage.MEDIASOUP_SESSION_CONTROLLER_LOG_LEVEL = "trace";
 * ```
 *
 * Disable trace output:
 * ```ts
 * localStorage.MEDIASOUP_SESSION_CONTROLLER_LOG_LEVEL = "off";
 * ```
 *
 * What it is NOT:
 * - Not a telemetry system.
 * - Not a persistent logger.
 * - Not a replacement for server logs.
 *
 * Use this when you want to see **exactly which** controller actions and events
 * fired and in what order, without changing application logic. This is
 * especially useful for diagnosing race conditions or unexpected UI state.
 *
 * @category Implementer API
 */
/**
 * Trace payload shape for structured logging.
 *
 * This type is intentionally loose (`Record<string, unknown>`) so trace output
 * can carry any context without forcing a schema. You typically won’t need to
 * reference it directly; it exists to document the shape of emitted records.
 *
 * @internal
 */
export type TraceDetail = Record<string, unknown>;

type LogLevel = "trace" | "off";

const readLogLevel = (): LogLevel => {
  try {
    const level = localStorage.getItem(
      "MEDIASOUP_SESSION_CONTROLLER_LOG_LEVEL",
    );
    if (level === "trace" || level === "off") {
      return level;
    }
    return "off";
  } catch {
    return "off";
  }
};

const levelRank: Record<LogLevel, number> = {
  trace: 10,
  off: 80,
};

const shouldLog = (level: LogLevel) =>
  levelRank[level] >= levelRank[readLogLevel()];

/**
 * Emit a trace log entry when the logger level allows it.
 *
 * - Uses `console.debug` so logs are visible but low‑priority.
 * - Tagged with a stable prefix for quick filtering:
 *   `mediasoup-session-controller:trace`.
 * - When logging is disabled, this function returns immediately.
 * - Intended for high‑frequency, structured events (actions + state changes).
 *
 * Reading trace output:
 * - Logs are tagged `mediasoup-session-controller:trace:<event>`.
 * - Action traces include an `action` key (e.g. `ROOM_ATTACH`).
 * - Event traces include an `event` key (e.g. `peerMediaOpened`).
 *
 * @internal
 */
export const traceController = (event: string, detail: TraceDetail) => {
  if (!shouldLog("trace")) {
    return;
  }
  console.debug(`[mediasoup-session-controller:trace:${event}]`, detail);
};
