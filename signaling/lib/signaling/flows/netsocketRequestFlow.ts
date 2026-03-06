/**
 * Netsocket protocol dispatch table for validated inbound media-server payloads.
 *
 * This module maps each netsocket message type to the owning domain service.
 *
 * @remarks
 * ```mermaid
 * flowchart TD
 *   IN[netsocket payload] --> SW[switch by payload.type]
 *   SW --> CORE[core room/peer/media service action]
 * ```
 */
import type { Socket as NetSocket } from "net";

import type {
  MediaInboundPayload,
  MediaInboundMessageMap,
  NodeId,
} from "../../protocol/signalingIoValidation.js";
import type { MediaServer } from "../../core/mediaServer/mediaServer.js";
import type { PeerMediaSession } from "../../core/peer/peerMediaSession.js";
import type { PeerWebRTCTransport } from "../../core/peer/peerWebRTCTransport.js";
import type { RoomRelay } from "../../core/room/roomRelay.js";
import type { StatusReporter } from "../../observability/statusReporter.js";

/**
 * Dependencies required to route validated inbound media-server payloads.
 *
 * Command callbacks are passed in so higher-level flow handlers can control
 * recoverable vs fatal behavior for late/out-of-order responses.
 */
export type NetsocketRequestFlowContext = {
  mediaServer: MediaServer;
  roomRelay: RoomRelay;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
  statusReporter: StatusReporter;
  onCreatedConsumer(message: MediaInboundMessageMap["createdConsumer"]): void;
  onCreatedRouterGroup(
    message: MediaInboundMessageMap["createdRouterGroup"],
  ): void;
  onCreatedMediaProducer(
    message: MediaInboundMessageMap["createdMediaProducer"],
  ): void;
};

/**
 * Stateful request flow for validated inbound media-server netsocket payloads.
 */
export class NetsocketRequestFlow {
  private readonly context: NetsocketRequestFlowContext;

  /**
   * Captures dispatch dependencies for one signaling runtime instance.
   *
   * @param context - Netsocket request-flow dependencies.
   */
  constructor(context: NetsocketRequestFlowContext) {
    this.context = context;
  }

  /**
   * Dispatches one validated netsocket payload to the appropriate domain action.
   *
   * Identity validation is intentionally out-of-scope here and must be done by
   * caller before invoking this method.
   *
   * @param params Dispatch inputs (`node`, `payload`, source `connection`).
   * @returns `void`.
   * @throws {Error} For unknown message types or downstream domain failures.
   */
  dispatch(params: {
    node: NodeId;
    payload: MediaInboundPayload;
    connection: NetSocket;
  }) {
    const { node, payload, connection } = params;
    const {
      mediaServer,
      roomRelay,
      peerWebRTCTransport,
      peerMediaSession,
      statusReporter,
      onCreatedConsumer,
      onCreatedRouterGroup,
      onCreatedMediaProducer,
    } = this.context;

    /**
     * Protocol dispatch table: one handler per inbound media-server payload type.
     *
     * @remarks Keep this switch in protocol-type order to simplify callback-flow tracing.
     */
    switch (payload.type) {
      case "registerMediaServer":
        mediaServer.registerMediaServer(connection, node, payload.message);
        return;
      case "unregisterMediaServer":
        mediaServer.unregisterMediaServer(connection, payload.message);
        connection.end();
        return;
      case "initializedNetworkRelay":
        roomRelay.initializedNetworkRelay(node, payload.message);
        return;
      case "connectedNetworkRelay":
        roomRelay.connectedNetworkRelay(node, payload.message);
        return;
      case "finalizedNetworkRelay":
        roomRelay.finalizedNetworkRelay(node, payload.message);
        return;
      case "createdConsumer":
        onCreatedConsumer(payload.message);
        return;
      case "serverLoad":
        mediaServer.recordServerLoad(connection, payload.message);
        return;
      case "mediaDiagnostic":
        mediaServer.recordMediaDiagnostic(connection, payload.message);
        return;
      case "createdRouterGroup":
        onCreatedRouterGroup(payload.message);
        return;
      case "createdWebRTCIngressTransport":
        peerWebRTCTransport.createdWebRTCIngressTransport(
          node,
          payload.message,
        );
        return;
      case "createdWebRTCEgressTransport":
        peerWebRTCTransport.createdWebRTCEgressTransport(node, payload.message);
        return;
      case "createdMediaProducer":
        onCreatedMediaProducer(payload.message);
        return;
      case "connectedWebRTCIngressTransport":
        peerWebRTCTransport.connectedWebRTCIngressTransport(payload.message);
        return;
      case "connectedWebRTCEgressTransport":
        peerWebRTCTransport.connectedWebRTCEgressTransport(payload.message);
        return;
      case "producerClosed":
        peerMediaSession.producerClosed(payload.message);
        return;
      case "disconnectedWebRTCTransport":
        peerWebRTCTransport.disconnectedWebRTCTransport(payload.message);
        return;
      case "routerDump":
        statusReporter.handleRouterDump(payload.message);
        return;
      default:
        throw new Error(
          `incomingNetsocketCommand blocked: node=${node}, reason=unknown message type, messageType=${payload.type}`,
        );
    }
  }
}
