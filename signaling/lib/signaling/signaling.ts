/**
 * Signaling control-plane facade.
 *
 * This class keeps listener-facing handlers and delegates runtime graph
 * composition to `signalingRuntimeTopology.ts`.
 *
 * @remarks
 * Runtime layering:
 * 1) listeners invoke this facade for transport lifecycle + inbound payloads,
 * 2) facade delegates into composed runtime services/flows,
 * 3) outbound adapters (`sendWebsocketMessage` / `sendNetsocketMessage`) bridge
 *    runtime messaging back to listener transports.
 */

import type { Guid, Peer } from "../../../types/baseTypes.d.ts";
import type {
  RequestMessage as UserRequestMessage,
  SystemDiagnosticEvent,
} from "../../../types/wsRelay.d.ts";
import {
  appendDiagnostic,
  getRecentDiagnosticsSnapshot,
} from "../observability/diagnosticsBuffer.js";
import { sendWebsocketMessageWithCleanup } from "./websocketIngressFlow.js";
import {
  composeSignalingRuntime,
  type MediaInboundPayload,
  type NodeId,
  type NsMessageMap,
  type SignalingDeps,
  type SignalingRuntime,
  type WsMessageMap,
} from "./signalingRuntimeTopology.js";
import type { Socket as NetSocket } from "net";

export type { SignalingDeps } from "./signalingRuntimeTopology.js";
export type {
  MediaServerPipe,
  RoutingTableItems,
} from "../protocol/signalingTypes.js";

/**
 * Central signaling control-plane coordinator.
 *
 * Responsibilities:
 * - expose listener lifecycle hooks,
 * - route inbound websocket/netsocket messages,
 * - provide outbound websocket/netsocket send adapters,
 * - retain runtime state for diagnostics and tests.
 */
class Signaling {
  /** Shared peer map retained for runtime orchestration and integration tests. */
  peers!: Map<Guid, Peer>;
  /** Internal runtime container with stores, ports, services, and policies. */
  private runtime!: SignalingRuntime;

  /**
   * Wires signaling runtime topology from listener dependencies.
   *
   * @param deps Listener/runtime dependencies required to compose signaling.
   */
  constructor(deps: SignalingDeps) {
    this.runtime = composeSignalingRuntime({
      deps,
      callbacks: {
        sendWebsocketMessage: this.sendWebsocketMessage,
        sendNetsocketMessage: this.sendNetsocketMessage,
        recordDiagnostic: this.recordDiagnostic,
        getRecentDiagnostics: this.getRecentDiagnostics,
      },
    });
    this.peers = this.runtime.stores.peers;
  }

  // Transport lifecycle hooks ----------------------------------------------

  /**
   * Handles media-server transport close from netsocket listener.
   *
   * @param connection Closed netsocket connection instance.
   */
  onNetsocketClose = (connection: NetSocket) => {
    this.runtime.services.mediaServer.handleNetsocketClose(connection);
  };

  /**
   * Handles websocket disconnect lifecycle and peer teardown.
   *
   * @param wsid Closed websocket id.
   */
  onWebsocketClose = (wsid: Guid) => {
    this.runtime.policies.rateLimit.onWebSocketDisconnected(wsid);
    const peerId = this.runtime.stores.sessions.getPeerIdByOrigin(wsid);
    if (peerId) {
      this.runtime.services.peerLifecycle.deletePeer(peerId);
    } else {
      this.runtime.stores.sessions.clearOrigin(wsid);
    }
  };

  /**
   * Starts periodic status broadcasting when first subscriber connects.
   *
   * @param wsid Newly connected status-subscriber websocket id.
   */
  onStatusSubscriberConnected = (wsid: Guid) => {
    void wsid;
    this.runtime.ports.statusReporter.start();
  };

  /**
   * Stops status broadcasting when the last subscriber disconnects.
   *
   * @param wsid Disconnected status-subscriber websocket id.
   */
  onStatusSubscriberDisconnected = (wsid: Guid) => {
    void wsid;
    if (this.runtime.ports.websocketServer.getStatusSubscriberCount() === 0) {
      this.runtime.ports.statusReporter.stop();
    }
  };

  /**
   * Records diagnostics emitted by listener adapters.
   *
   * @param event Diagnostic payload without timestamp (`at` is added here).
   */
  onListenerDiagnostic = (event: Omit<SystemDiagnosticEvent, "at">) => {
    this.recordDiagnostic(event);
  };

  // Incoming message handling ----------------------------------------------

  /**
   * Processes one inbound netsocket payload from a media server.
   *
   * @param node Claimed source node id from netsocket envelope.
   * @param payload Typed inbound media-server payload.
   * @param connection Source netsocket connection.
   */
  incomingNetsocketCommand = (
    node: NodeId,
    payload: MediaInboundPayload,
    connection: NetSocket,
  ) => {
    this.runtime.services.netsocketFlow.handle(node, payload, connection);
  };

  /**
   * Processes one inbound websocket request from a client peer.
   *
   * @param wsid Origin websocket id.
   * @param signal Typed websocket request payload.
   */
  incomingWebsocketSignal = async (wsid: Guid, signal: UserRequestMessage) => {
    await this.runtime.services.websocketFlow.handle(wsid, signal);
  };

  // Outbound dispatch and IO ------------------------------------------------

  /**
   * Sends websocket message via listener adapter with deterministic cleanup on failure.
   *
   * @param wsid Destination websocket id.
   * @param type Outbound websocket protocol message type.
   * @param message Typed message payload.
   */
  private sendWebsocketMessage = <T extends keyof WsMessageMap>(
    wsid: Guid,
    type: T,
    message: WsMessageMap[T],
  ) => {
    sendWebsocketMessageWithCleanup({
      wsid,
      type,
      message,
      websocketServer: this.runtime.ports.websocketServer,
      recordDiagnostic: this.recordDiagnostic,
      onStatusSubscriberDisconnected: this.onStatusSubscriberDisconnected,
      onWebsocketClose: this.onWebsocketClose,
    });
  };

  /**
   * Sends typed netsocket protocol messages to a target media-server channel.
   *
   * @param destinationNode Target media-server id.
   * @param channel Target server channel (`ingress` or `egress`).
   * @param type Outbound netsocket protocol message type.
   * @param message Typed message payload.
   */
  private sendNetsocketMessage = <T extends keyof NsMessageMap>(
    destinationNode: Guid,
    channel: "ingress" | "egress",
    type: T,
    message: NsMessageMap[T],
  ) => {
    this.runtime.ports.netsocketServer.send(
      destinationNode,
      channel,
      type,
      message,
    );
  };

  // Diagnostics -------------------------------------------------------------

  /**
   * Appends one diagnostic event into bounded in-memory diagnostics buffer.
   *
   * @param event Diagnostic payload without timestamp (`at` is added here).
   */
  private recordDiagnostic = (event: Omit<SystemDiagnosticEvent, "at">) => {
    appendDiagnostic(this.runtime.stores.diagnosticsRecent, event);
  };

  /**
   * Returns a snapshot copy of recent diagnostics for status reporting/testing.
   *
   * @returns Recent diagnostics in append order (oldest to newest).
   */
  private getRecentDiagnostics = () => {
    return getRecentDiagnosticsSnapshot(this.runtime.stores.diagnosticsRecent);
  };
}

export default Signaling;
