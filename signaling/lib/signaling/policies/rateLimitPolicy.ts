/**
 * Default and reusable rate-limit policy implementations.
 */
import type { Guid } from "../../../../types/baseTypes.d.ts";
import type { RateLimitPolicies } from "./types.js";

/**
 * Rate-limit policy that never rejects requests.
 *
 * Useful as the default development policy and as a baseline for tests.
 */
export const createUnlimitedRateLimitPolicy = (): RateLimitPolicies => ({
  /** Always allows request processing for current websocket. */
  allowWebSocketRequest: () => ({ allowed: true }),
  /** No-op cleanup hook for unlimited policy mode. */
  onWebSocketDisconnected: () => {},
});

/**
 * Fixed-window per-websocket request limiter.
 *
 * Tracks request counts per `wsid` and denies requests beyond
 * `maxRequestsPerWindow` until the time window rolls over.
 */
export const createFixedWindowRateLimitPolicy = (params: {
  maxRequestsPerWindow: number;
  windowMs: number;
}): RateLimitPolicies => {
  const requestsBySocket = new Map<
    Guid,
    { windowStartMs: number; count: number }
  >();
  return {
    /**
     * Evaluates request budget for current websocket fixed window.
     *
     * @param wsid Websocket id being evaluated.
     * @param nowMs Current time in milliseconds.
     * @returns Allow/deny decision with stable detail string on deny.
     */
    allowWebSocketRequest: ({ wsid, nowMs }) => {
      const existing = requestsBySocket.get(wsid);
      if (!existing || nowMs - existing.windowStartMs >= params.windowMs) {
        requestsBySocket.set(wsid, { windowStartMs: nowMs, count: 1 });
        return { allowed: true };
      }
      if (existing.count >= params.maxRequestsPerWindow) {
        return {
          allowed: false,
          detail: "request rate limit exceeded",
        };
      }
      existing.count += 1;
      return { allowed: true };
    },
    /** Clears in-memory request counters for disconnected websocket. */
    onWebSocketDisconnected: (wsid) => {
      requestsBySocket.delete(wsid);
    },
  };
};

/**
 * Default rate-limit policy for signaling.
 */
export const defaultRateLimitPolicy = createUnlimitedRateLimitPolicy();
