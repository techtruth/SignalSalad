/**
 * Shared trace payload envelope for websocket/netsocket event logs.
 *
 * Tracing intentionally accepts open-ended payload shape because it mirrors
 * multiple protocol message families.
 */
export type TracePayload = {
  type?: string;
  message?: unknown;
  [key: string]: unknown;
};

/**
 * Structured trace toggles for low-overhead signaling diagnostics.
 *
 * Intended for development/investigation only; logs are off by default unless
 * `SIGNAL_TRACE` is truthy.
 */
const TRACE_ENABLED = (() => {
  const value = (process.env.SIGNAL_TRACE || "").toLowerCase();
  return value === "1" || value === "true" || value === "yes";
})();

/**
 * Protocol keys whose values can be large/noisy and are therefore redacted in
 * trace output.
 */
const OMIT_KEYS = new Set([
  "rtpCapabilities",
  "rtpCaps",
  "roomRTPCapabilities",
  "dtlsParameters",
  "iceCandidates",
  "iceParameters",
  "sctpParameters",
  "rtpParameters",
]);

/**
 * Produces a trace-safe message projection by stripping high-volume protocol
 * fields while preserving enough metadata to diagnose signaling flow.
 */
const compactMessage = (message: unknown) => {
  if (!message || typeof message !== "object") {
    return message;
  }
  const result: TracePayload = {};
  for (const [key, value] of Object.entries(message as TracePayload)) {
    if (OMIT_KEYS.has(key)) {
      result[key] = "[omitted]";
      continue;
    }
    if (key === "producerOptions" && value && typeof value === "object") {
      const options = value as TracePayload;
      const appData = options.appData as TracePayload | undefined;
      result[key] = {
        kind: options.kind,
        appData: appData?.source ? { source: appData.source } : options.appData,
      };
      continue;
    }
    if (key === "consumerOptions" && value && typeof value === "object") {
      const options = value as TracePayload;
      result[key] = {
        kind: options.kind,
        producerId: options.producerId,
      };
      continue;
    }
    result[key] = value;
  }
  return result;
};

/**
 * Emits a namespaced trace event when tracing is enabled.
 *
 * Event namespace conventions:
 * - `room`: room membership lifecycle
 * - `peer`: peer lifecycle and cleanup flow
 * - `ws_*`: websocket ingress/egress/failure
 * - `ns_*`: netsocket ingress/egress
 * - `media_server`: media-server lifecycle orchestration
 */
const emit = (event: string, detail: TracePayload) => {
  if (!TRACE_ENABLED) {
    return;
  }
  console.debug(`[signal-trace:${event}]`, detail);
};

/**
 * Emits room-membership lifecycle traces (`join`/`leave`/`clear`).
 *
 * `detail` is optional free-form context for uncommon transitions.
 */
export const traceRoom = (
  action: "join" | "leave" | "clear",
  room: string,
  peerId: string,
  detail?: string,
) => {
  emit("room", { action, room, peerId, detail });
};

/**
 * Emits peer lifecycle traces for identity, disconnect, teardown, and cleanup flow.
 */
export const tracePeerLifecycle = (action: string, detail: TracePayload) => {
  emit("peer", {
    action,
    ...detail,
  });
};

/**
 * Emits inbound websocket request traces.
 *
 * Payload body is compacted via `compactMessage` before logging.
 */
export const traceWsIn = (wsid: string, signal: TracePayload) => {
  emit("ws_in", {
    wsid,
    type: signal.type,
    message: compactMessage(signal.message),
  });
};

/**
 * Emits outbound websocket response traces.
 *
 * High-frequency `systemStatus` messages are suppressed to keep trace streams
 * useful during interactive debugging sessions.
 */
export const traceWsOut = (wsid: string, message: TracePayload) => {
  if (message.type === "systemStatus") {
    return;
  }
  emit("ws_out", {
    wsid,
    type: message.type,
    message: compactMessage(message.message),
  });
};

/**
 * Emits websocket protocol/state failure traces with stable error taxonomy.
 */
export const traceWsFail = (wsid: string, error: string, detail?: string) => {
  emit("ws_fail", { wsid, error, detail });
};

/**
 * Emits inbound netsocket payload traces from media nodes.
 */
export const traceNsIn = (node: string, payload: TracePayload) => {
  emit("ns_in", {
    node,
    type: payload.type,
    message: compactMessage(payload.message),
  });
};

/**
 * Emits outbound netsocket payload traces to media nodes.
 */
export const traceNsOut = (node: string, payload: TracePayload) => {
  emit("ns_out", {
    node,
    type: payload.type,
    message: compactMessage(payload.message),
  });
};

/**
 * Emits media-server lifecycle traces (registration, ejection, and cleanup).
 */
export const traceMediaServerLifecycle = (
  action: string,
  detail: TracePayload,
) => {
  emit("media_server", {
    action,
    ...detail,
  });
};
