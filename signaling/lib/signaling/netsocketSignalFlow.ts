/**
 * Netsocket signaling flow orchestration for signaling.
 *
 * Responsibilities:
 * - validate and dispatch inbound media-server messages,
 * - map media callbacks to websocket-facing outcomes,
 * - classify late/out-of-order callback failures as recoverable when safe.
 *
 * @remarks
 * ```mermaid
 * flowchart TD
 *   NS[NetSocket Frame] --> ID[MediaServer.validateNetsocketIdentity]
 *   ID --> DISP[NetsocketRequestFlow.dispatch]
 *   DISP --> CORE[Room/Peer/Media Services]
 *   CORE --> WS[WebSocket Updates]
 *   DISP --> CB[Callback Mapping Helpers]
 *   CB --> WS
 *   DISP -->|recoverable state drift| WARN[diagnostic warn + ignore]
 * ```
 */
import type { Socket as NetSocket } from "net";

import type { Guid, Peer } from "../../../types/baseTypes.d.ts";
import type { SystemDiagnosticEvent } from "../../../types/wsRelay.d.ts";
import type { MediaServer } from "../core/mediaServer/mediaServer.js";
import type { ProducerRegistry } from "../core/peer/producerRegistry.js";
import type { PeerMediaSession } from "../core/peer/peerMediaSession.js";
import type { PeerSessions } from "../core/peer/peerSessions.js";
import {
  PeerStateError,
  requireMediaPeerByOrigin as requireMediaPeerByOriginState,
  requirePeer as requirePeerState,
} from "../core/peer/peerStateMachine.js";
import type { PeerWebRTCTransport } from "../core/peer/peerWebRTCTransport.js";
import type { RoomRelay } from "../core/room/roomRelay.js";
import type { StatusReporter } from "../observability/statusReporter.js";
import { RecoverableNetsocketCommandError } from "../protocol/netsocketCommandErrors.js";
import type { SignalingMessenger } from "../protocol/signalingMessenger.js";
import type {
  MediaInboundMessageMap,
  MediaInboundPayload,
  NodeId,
} from "../protocol/signalingIoValidation.js";
import { NetsocketRequestFlow } from "./flows/netsocketRequestFlow.js";
import { handleNetsocketResponse } from "./flows/netsocketResponseFlow.js";

/**
 * Callback payload types that may arrive after peer/session teardown.
 *
 * These are treated as potentially stale state echoes from media servers.
 * Register/unregister/load/diagnostic commands are intentionally excluded and
 * must fail hard when invalid.
 */
const RECOVERABLE_NETSOCKET_RESPONSE_TYPES = new Set<
  MediaInboundPayload["type"]
>([
  "initializedNetworkRelay",
  "connectedNetworkRelay",
  "finalizedNetworkRelay",
  "createdConsumer",
  "createdRouterGroup",
  "createdWebRTCIngressTransport",
  "createdWebRTCEgressTransport",
  "createdMediaProducer",
  "connectedWebRTCIngressTransport",
  "connectedWebRTCEgressTransport",
  "producerClosed",
  "disconnectedWebRTCTransport",
  "routerDump",
]);

/**
 * Runtime invariant helper used by mapping callbacks.
 *
 * @param value Value expected to be present.
 * @param message Error message emitted if value is absent.
 * @returns Non-null value.
 * @throws {Error} When `value` is `null` or `undefined`.
 */
const requireValue = <T>(value: T | undefined | null, message: string): T => {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
};

/**
 * Normalizes unknown thrown values into proper `Error` instances.
 *
 * @param error - Unknown thrown value.
 * @returns Normalized `Error` instance.
 */
const normalizeRequestError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
};

/**
 * Emits a diagnostic event for non-recoverable netsocket command failures.
 *
 * @param params - Failure context for one netsocket command execution.
 * @returns `void`.
 */
const recordNetsocketCommandFailure = (params: {
  node: NodeId;
  payload: MediaInboundPayload;
  error: Error;
  recordDiagnostic: (event: Omit<SystemDiagnosticEvent, "at">) => void;
}) => {
  params.recordDiagnostic({
    severity: "error",
    category: "netsocketCommand",
    message: `netsocket command failed: ${params.payload.type}`,
    details: params.error.message,
    context: {
      node: params.node,
      messageType: params.payload.type,
    },
  });
};

/**
 * Returns true when a netsocket callback failure can be safely ignored.
 *
 * Recoverable means state drift or expected late delivery; non-recoverable
 * failures indicate genuine command-processing defects.
 *
 * @param payload Inbound payload being processed.
 * @param error Normalized processing error.
 * @returns `true` when error is safely recoverable.
 */
const isRecoverableNetsocketStateDrift = (
  payload: MediaInboundPayload,
  error: Error,
) => {
  if (!RECOVERABLE_NETSOCKET_RESPONSE_TYPES.has(payload.type)) {
    return false;
  }
  return (
    error instanceof PeerStateError ||
    error instanceof RecoverableNetsocketCommandError
  );
};

/**
 * Runtime dependencies for netsocket signaling flow.
 *
 * This context intentionally exposes only protocol + domain ports used by
 * netsocket command dispatch and callback mapping.
 */
export type NetsocketSignalFlowContext = {
  mediaServer: MediaServer;
  roomRelay: RoomRelay;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
  statusReporter: StatusReporter;
  sessions: PeerSessions;
  peers: Map<Guid, Peer>;
  producers: ProducerRegistry;
  recordDiagnostic: (event: Omit<SystemDiagnosticEvent, "at">) => void;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
};

/**
 * Handles inbound netsocket signaling with prebound request-flow dependencies.
 */
export class NetsocketSignalFlow {
  private readonly context: NetsocketSignalFlowContext;
  private readonly requestFlow: NetsocketRequestFlow;

  /**
   * Pre-binds request-flow callbacks and protocol adapters for netsocket signaling.
   *
   * @param context - Netsocket flow dependencies for one signaling runtime.
   */
  constructor(context: NetsocketSignalFlowContext) {
    this.context = context;
    this.requestFlow = new NetsocketRequestFlow({
      mediaServer: context.mediaServer,
      roomRelay: context.roomRelay,
      peerWebRTCTransport: context.peerWebRTCTransport,
      peerMediaSession: context.peerMediaSession,
      statusReporter: context.statusReporter,
      onCreatedConsumer: this.onCreatedConsumer,
      onCreatedRouterGroup: this.onCreatedRouterGroup,
      onCreatedMediaProducer: this.onCreatedMediaProducer,
    });
  }

  /**
   * Maps `createdConsumer` callback into websocket media announcements.
   *
   * @param consumers - Consumer payload keyed by egress transport id.
   * @returns `void`.
   * @throws {RecoverableNetsocketCommandError} When peer/session state has
   * advanced and callback replay is no longer applicable.
   */
  private onCreatedConsumer = (
    consumers: MediaInboundMessageMap["createdConsumer"],
  ) => {
    try {
      handleNetsocketResponse({
        type: "createdConsumer",
        consumers,
        sessions: this.context.sessions,
        requireValue,
        requirePeer: (peerId, context) =>
          requirePeerState({
            peers: this.context.peers,
            peerId,
            context,
            invariantScope: "signaling",
          }),
        sendWebsocketMessage: this.context.sendWebsocketMessage,
      });
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "stateDrift",
        message:
          "createdConsumer callback could not be applied to current signaling state",
        cause: error,
      });
    }
  };

  /**
   * Maps `createdRouterGroup` callback into websocket `joinedRoom` response.
   *
   * @param message - Router-group callback payload from media server.
   * @returns `void`.
   * @throws {RecoverableNetsocketCommandError} When joined-room delivery is
   * no longer possible because websocket ownership changed before callback arrival.
   */
  private onCreatedRouterGroup = (
    message: MediaInboundMessageMap["createdRouterGroup"],
  ) => {
    try {
      handleNetsocketResponse({
        type: "createdRouterGroup",
        message,
        sendWebsocketMessage: this.context.sendWebsocketMessage,
      });
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "deliveryUnavailable",
        message: "createdRouterGroup callback delivery is no longer available",
        cause: error,
      });
    }
  };

  /**
   * Maps `createdMediaProducer` callback into producer registry + websocket ack.
   *
   * @param message - Producer-created callback payload from media server.
   * @returns `void`.
   * @throws {RecoverableNetsocketCommandError} When producer owner/session has
   * already left and callback application would be stale.
   */
  private onCreatedMediaProducer = (
    message: MediaInboundMessageMap["createdMediaProducer"],
  ) => {
    try {
      handleNetsocketResponse({
        type: "createdMediaProducer",
        message,
        requireMediaPeerByOrigin: (originId, context) =>
          requireMediaPeerByOriginState({
            peers: this.context.peers,
            sessions: this.context.sessions,
            originId,
            context,
            invariantScope: "signaling",
          }),
        producers: this.context.producers,
        sendWebsocketMessage: this.context.sendWebsocketMessage,
      });
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "stateDrift",
        message:
          "createdMediaProducer callback could not be applied to current signaling state",
        cause: error,
      });
    }
  };

  /**
   * Executes one inbound netsocket command.
   *
   * Processing order:
   * 1) prune old offline events,
   * 2) validate netsocket identity envelope,
   * 3) dispatch payload by protocol type.
   *
   * @param node Claimed media-server node id from envelope.
   * @param payload Typed inbound netsocket payload.
   * @param connection Source netsocket connection.
   * @returns `void`.
   * @throws {Error} For non-recoverable validation/dispatch failures.
   */
  handle(node: NodeId, payload: MediaInboundPayload, connection: NetSocket) {
    try {
      this.context.mediaServer.pruneExpiredServerOfflineEvents();
      this.context.mediaServer.validateNetsocketIdentity(
        node,
        payload,
        connection,
      );
      this.requestFlow.dispatch({
        node,
        payload,
        connection,
      });
    } catch (error) {
      const normalizedError = normalizeRequestError(error);
      if (isRecoverableNetsocketStateDrift(payload, normalizedError)) {
        this.context.recordDiagnostic({
          severity: "warn",
          category: "netsocketCommand",
          message: `recoverable netsocket callback ignored: ${payload.type}`,
          details: normalizedError.message,
          context: {
            node,
            messageType: payload.type,
          },
        });
        console.warn("Recoverable netsocket callback ignored", {
          node,
          messageType: payload.type,
          error: normalizedError.message,
        });
        return;
      }
      recordNetsocketCommandFailure({
        node,
        payload,
        error: normalizedError,
        recordDiagnostic: this.context.recordDiagnostic,
      });
      throw normalizedError;
    }
  }
}
