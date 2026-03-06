/**
 * Websocket ingress flow orchestration for signaling.
 *
 * Responsibilities:
 * - dispatch typed websocket requests through policy + ownership guards,
 * - convert failures into stable websocket error payloads,
 * - record diagnostics and enforce deterministic cleanup on send failures.
 *
 * @remarks
 * ```mermaid
 * flowchart TD
 *   WS[WebSocket Request] --> DISP[WebsocketRequestFlow.dispatch]
 *   DISP --> GUARDS[Ownership + Policy Guards]
 *   GUARDS --> DOMAIN[Peer/Room/Media Services]
 *   DOMAIN --> SEND[sendWebsocketMessageWithCleanup]
 *   DISP -->|throw| ERR[mapWebSocketRequestError]
 *   ERR --> SEND
 *   SEND -->|send failure| CLEANUP[local disconnect cleanup]
 * ```
 */
import type { Guid } from "../../../types/baseTypes.d.ts";
import type {
  RequestMessage as UserRequestMessage,
  SystemDiagnosticEvent,
} from "../../../types/wsRelay.d.ts";
import type { MediaServerRegistry } from "../core/mediaServer/serverRegistry.js";
import { PeerStateError } from "../core/peer/peerStateMachine.js";
import type { Peer as PeerLifecycle } from "../core/peer/peer.js";
import type { PeerExtendedControl } from "../core/peer/peerExtendedControl.js";
import type { PeerMediaSession } from "../core/peer/peerMediaSession.js";
import type { PeerSessions } from "../core/peer/peerSessions.js";
import type { PeerWebRTCTransport } from "../core/peer/peerWebRTCTransport.js";
import type { Room } from "../core/room/room.js";
import type { WebSocketServer } from "../listeners/websocketServer.js";
import type { StatusReporter } from "../observability/statusReporter.js";
import type { WsMessageMap } from "../protocol/signalingIoValidation.js";
import type { SignalingMessenger } from "../protocol/signalingMessenger.js";
import { buildWebsocketErrorMessage } from "../protocol/websocketResponseBuilders.js";
import { WebsocketRequestFlow } from "./flows/websocketRequestFlow.js";
import type { SignalingPolicies } from "./policies/types.js";

/**
 * Error category for client-correctable websocket request failures.
 *
 * These errors map to protocol code `requestRejected`.
 */
export class RejectedWebSocketRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejectedWebSocketRequestError";
  }
}

/**
 * Throws a standardized client-correctable request rejection.
 *
 * Dispatcher and guard code uses this helper to keep rejection semantics uniform.
 *
 * @param message Human-readable rejection reason for diagnostics/client response.
 * @throws {RejectedWebSocketRequestError} Always throws.
 */
export const rejectedWebSocketRequest = (message: string): never => {
  throw new RejectedWebSocketRequestError(message);
};

/**
 * Normalizes unknown thrown values into proper `Error` instances.
 *
 * @param error Unknown thrown value.
 * @returns Normalized error object.
 */
const normalizeRequestError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
};

/**
 * Narrows errors to categories that should map to `requestRejected`.
 *
 * @param error - Normalized request processing error.
 * @returns `true` when error is client-correctable.
 */
const isRejectedRequestCategory = (
  error: Error,
): error is RejectedWebSocketRequestError | PeerStateError =>
  error instanceof RejectedWebSocketRequestError ||
  error instanceof PeerStateError;

/**
 * Converts internal websocket processing errors into stable protocol payloads.
 *
 * Mapping rules:
 * - client-correctable errors -> `requestRejected`
 * - all other failures -> `requestFailed`
 *
 * Internal error details are not exposed for `requestFailed` responses.
 *
 * @param params Error mapping inputs.
 * @returns Typed websocket `error` payload.
 */
const mapWebSocketRequestError = (params: {
  signalType: UserRequestMessage["type"];
  error: Error;
}): WsMessageMap["error"] => {
  if (isRejectedRequestCategory(params.error)) {
    return buildWebsocketErrorMessage("requestRejected", params.error.message);
  }
  return buildWebsocketErrorMessage(
    "requestFailed",
    `Could not complete request '${params.signalType}'`,
  );
};

/**
 * Handles websocket request failure end-to-end.
 *
 * Responsibilities:
 * - record diagnostics
 * - attempt error response delivery
 * - close socket on error-reply failure
 *
 * @param params Failure context for one websocket request execution.
 * @returns `void`.
 */
const recordWebsocketRequestFailure = (params: {
  wsid: Guid;
  signal: UserRequestMessage;
  error: unknown;
  recordDiagnostic: (event: Omit<SystemDiagnosticEvent, "at">) => void;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
  websocketServer: Pick<WebSocketServer, "close">;
}) => {
  const normalizedError = normalizeRequestError(params.error);
  params.recordDiagnostic({
    severity: "warn",
    category: "websocketRequest",
    message: `websocket request failed: ${params.signal.type}`,
    details: normalizedError.message,
    context: {
      wsid: params.wsid,
      messageType: params.signal.type,
    },
  });

  console.error("incomingWebsocketSignal failed", {
    error: normalizedError.message,
    messageType: params.signal.type,
    signal: params.signal,
  });

  try {
    const errorResponse = mapWebSocketRequestError({
      signalType: params.signal.type,
      error: normalizedError,
    });
    params.sendWebsocketMessage(params.wsid, "error", errorResponse);
  } catch (sendError) {
    const normalizedSendError = normalizeRequestError(sendError);
    params.recordDiagnostic({
      severity: "warn",
      category: "websocketRequest",
      message: `websocket error reply failed: ${params.signal.type}`,
      details: normalizedSendError.message,
      context: {
        wsid: params.wsid,
        messageType: params.signal.type,
      },
    });
    console.warn("Failed to send websocket error response", {
      wsid: params.wsid,
      messageType: params.signal.type,
      error: normalizedSendError.message,
    });

    try {
      params.websocketServer.close(params.wsid, 1011);
    } catch (closeError) {
      const normalizedCloseError = normalizeRequestError(closeError);
      params.recordDiagnostic({
        severity: "warn",
        category: "websocketRequest",
        message: `websocket close after error-reply failure failed: ${params.signal.type}`,
        details: normalizedCloseError.message,
        context: {
          wsid: params.wsid,
          messageType: params.signal.type,
        },
      });
      console.warn("Failed to close websocket after error reply failure", {
        wsid: params.wsid,
        messageType: params.signal.type,
        error: normalizedCloseError.message,
      });
    }
  }
};

/**
 * Runtime dependencies for websocket ingress flow.
 *
 * Exposes only protocol/domain ports needed for request dispatch and failure
 * handling, keeping signaling composition boundaries explicit.
 */
export type WebsocketIngressFlowContext = {
  policies: SignalingPolicies;
  sessions: PeerSessions;
  serverRegistry: MediaServerRegistry;
  peerLifecycle: PeerLifecycle;
  peerExtendedControl: PeerExtendedControl;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
  room: Room;
  websocketServer: WebSocketServer;
  statusReporter: StatusReporter;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
  recordDiagnostic: (event: Omit<SystemDiagnosticEvent, "at">) => void;
};

/**
 * Handles inbound websocket signaling with prebound request-flow dependencies.
 */
export class WebsocketIngressFlow {
  private readonly context: WebsocketIngressFlowContext;
  private readonly requestFlow: WebsocketRequestFlow;

  /**
   * Pre-binds request flow with signaling policies and domain services.
   *
   * @param context - Websocket flow dependencies for one signaling runtime.
   */
  constructor(context: WebsocketIngressFlowContext) {
    this.context = context;
    this.requestFlow = new WebsocketRequestFlow({
      policies: context.policies,
      sessions: context.sessions,
      serverRegistry: context.serverRegistry,
      peerLifecycle: context.peerLifecycle,
      peerExtendedControl: context.peerExtendedControl,
      peerWebRTCTransport: context.peerWebRTCTransport,
      peerMediaSession: context.peerMediaSession,
      room: context.room,
      websocketServer: context.websocketServer,
      statusReporter: context.statusReporter,
      sendWebsocketMessage: context.sendWebsocketMessage,
      rejectedWebSocketRequest,
    });
  }

  /**
   * Executes one inbound websocket request.
   *
   * This method never rethrows by design; failures are converted to websocket
   * error responses and diagnostics.
   *
   * @param wsid Origin websocket id.
   * @param signal Typed websocket request payload.
   * @returns `Promise<void>`.
   */
  async handle(wsid: Guid, signal: UserRequestMessage) {
    try {
      await this.requestFlow.dispatch({
        wsid,
        signal,
      });
    } catch (error) {
      recordWebsocketRequestFailure({
        wsid,
        signal,
        error,
        recordDiagnostic: this.context.recordDiagnostic,
        sendWebsocketMessage: this.context.sendWebsocketMessage,
        websocketServer: this.context.websocketServer,
      });
    }
  }
}

/**
 * Sends one websocket response and performs deterministic local cleanup when send fails.
 *
 * Cleanup behavior on send failure:
 * - emit diagnostics,
 * - attempt websocket close (1011),
 * - prune local connection map,
 * - trigger signaling lifecycle callbacks.
 *
 * @param params Outbound delivery and cleanup dependencies.
 * @returns `void`.
 * @throws {Error} Re-throws send failure after cleanup attempts.
 */
export const sendWebsocketMessageWithCleanup = <
  T extends keyof WsMessageMap,
>(params: {
  wsid: Guid;
  type: T;
  message: WsMessageMap[T];
  websocketServer: WebSocketServer;
  recordDiagnostic: (event: Omit<SystemDiagnosticEvent, "at">) => void;
  onStatusSubscriberDisconnected: (wsid: Guid) => void;
  onWebsocketClose: (wsid: Guid) => void;
}) => {
  try {
    params.websocketServer.send(params.wsid, params.type, params.message);
  } catch (error) {
    const normalizedError = normalizeRequestError(error);
    params.recordDiagnostic({
      severity: "warn",
      category: "websocketRequest",
      message: "websocket send failed; forcing local disconnect cleanup",
      details: normalizedError.message,
      context: {
        wsid: params.wsid,
        messageType: params.type,
      },
    });
    try {
      params.websocketServer.close(params.wsid, 1011);
    } catch (closeError) {
      const normalizedCloseError = normalizeRequestError(closeError);
      params.recordDiagnostic({
        severity: "warn",
        category: "websocketRequest",
        message: "websocket close after send failure failed",
        details: normalizedCloseError.message,
        context: {
          wsid: params.wsid,
          messageType: params.type,
        },
      });
    }
    const { wasStatusSubscriber } = params.websocketServer.pruneConnection(
      params.wsid,
    );
    try {
      if (wasStatusSubscriber) {
        params.onStatusSubscriberDisconnected(params.wsid);
      }
      params.onWebsocketClose(params.wsid);
    } catch (cleanupError) {
      const normalizedCleanupError = normalizeRequestError(cleanupError);
      params.recordDiagnostic({
        severity: "warn",
        category: "websocketRequest",
        message: "local websocket cleanup after send failure failed",
        details: normalizedCleanupError.message,
        context: {
          wsid: params.wsid,
          messageType: params.type,
        },
      });
    }
    throw normalizedError;
  }
};
