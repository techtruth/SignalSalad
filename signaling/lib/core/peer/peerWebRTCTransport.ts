import type {
  DtlsParameters,
  NumSctpStreams,
  RtpCapabilities,
} from "mediasoup/types";

import type {
  Guid,
  JoinedPeer,
  MediaReadyPeer,
  Peer,
} from "../../../../types/baseTypes.d.ts";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import type {
  MediaInboundMessageMap,
  SignalingDiagnosticEvent,
} from "../../protocol/signalingIoValidation.js";
import {
  applyPeerEvent,
  assertValidPeerInvariant,
  buildPeerFailure,
  canApplyPeerEvent,
  clearPeerRuntimeBindings,
  isPeerMediaReady,
  PeerStateError,
} from "./peerStateMachine.js";
import {
  buildConnectWebRTCTransportMessage,
  buildCreateWebRTCEgressTransportMessage,
  buildCreateWebRTCIngressTransportMessage,
} from "../../protocol/netsocketMessageBuilders.js";
import {
  buildCreatedEgressMessage,
  buildTransportDetailsMessage,
  type WebRTCTransportDetails,
} from "../../protocol/websocketMessageBuilders.js";
import {
  buildConnectedEgressMessage,
  buildConnectedIngressMessage,
} from "../../protocol/websocketResponseBuilders.js";
import { RecoverableNetsocketCommandError } from "../../protocol/netsocketCommandErrors.js";
import { tracePeerLifecycle } from "../../observability/trace.js";

/** Diagnostic payload forwarded to shared signaling diagnostics (timestamp is injected by caller). */
export type DiagnosticEvent = SignalingDiagnosticEvent;
/** WebRTC transport direction used across create/connect/disconnect flows. */
export type TransportDirection = "ingress" | "egress";
type CreateTransportContext =
  | "signaling.createIngressTransport"
  | "signaling.createEgressTransport";

type ExpectedDisconnect = {
  peerId: Guid;
  direction: TransportDirection;
};

const MAX_EXPECTED_DISCONNECTS = 8192;

/** Session index operations required by transport attach/disconnect flows. */
export type PeerTransportSessionsPort = {
  attachTransport(
    peerId: Guid,
    serverId: Guid,
    transportId: Guid,
    direction: "ingress" | "egress",
  ): boolean;
  clearTransportsForPeer(peer: Peer): void;
  getPeerIdByOrigin(originId: Guid): Guid | undefined;
  getPeerIdByTransport(
    transportId: Guid,
    direction: "ingress" | "egress",
  ): Guid | undefined;
  removeTransportFromPeer(
    peerId: Guid,
    transportId: Guid,
    direction: "ingress" | "egress",
  ): boolean;
  dropTransportMapping(
    transportId: Guid,
    direction: "ingress" | "egress",
  ): void;
  isPeerClosing(peerId: Guid): boolean;
  hasAnyTransports(peerId: Guid): boolean;
  removePeer(peerId: Guid): unknown;
};

/** Producer ownership lookup used during transport disconnect cleanup. */
export type PeerTransportProducerPort = {
  getPeerProducerIds(peerId: Guid): Guid[];
};

/** Peer-state lifecycle helpers used by transport request/response handlers. */
export type PeerTransportStateAccessPort = {
  requirePeer: (peerId: Guid, context: string) => Peer;
  requireAttachedPeer: (peerId: Guid, context: string) => JoinedPeer;
  withRtpCapabilities: (
    peer: JoinedPeer,
    rtpCapabilities: RtpCapabilities,
  ) => MediaReadyPeer;
  savePeer: (peer: Peer) => void;
  requirePeerIdByOrigin: (originId: Guid, context: string) => Guid;
};

/** Room hooks used to reevaluate egress-readiness after transport changes. */
export type PeerTransportRoomPort = {
  maybeNotifyRoomEgressReady: (room: string) => void;
};

/** Pipe-registry cleanup hook used during unexpected peer teardown. */
export type PeerTransportPipeRegistryPort = {
  stripProducersFromPipes: (producerIds: Set<Guid>) => void;
};

/** Dependencies used by peer transport lifecycle orchestration. */
export type PeerTransportContext = {
  peers: Map<Guid, Peer>;
  sessions: PeerTransportSessionsPort;
  producers: PeerTransportProducerPort;
  ingressTransportDetails: Map<Guid, WebRTCTransportDetails>;
  egressTransportDetails: Map<Guid, WebRTCTransportDetails>;
  peerState: PeerTransportStateAccessPort;
  signalingMessenger: SignalingMessenger;
  room: PeerTransportRoomPort;
  pipeRegistry: PeerTransportPipeRegistryPort;
  recordDiagnostic: (event: DiagnosticEvent) => void;
};

/**
 * Owns peer WebRTC transport lifecycle.
 *
 * Responsibilities:
 * - request/create/connect transport commands
 * - map created transport responses back to peers
 * - handle disconnect and transport cleanup state transitions
 */
export class PeerWebRTCTransport {
  private readonly context: PeerTransportContext;
  private readonly expectedDisconnects: Map<string, ExpectedDisconnect>;
  private readonly expectedDisconnectOrder: string[];

  constructor(context: PeerTransportContext) {
    this.context = context;
    this.expectedDisconnects = new Map();
    this.expectedDisconnectOrder = [];
  }

  private buildExpectedDisconnectKey(
    transportId: Guid,
    direction: TransportDirection,
  ) {
    return `${direction}:${transportId}`;
  }

  private trimExpectedDisconnects() {
    while (this.expectedDisconnectOrder.length > MAX_EXPECTED_DISCONNECTS) {
      const evicted = this.expectedDisconnectOrder.shift();
      if (!evicted) {
        break;
      }
      this.expectedDisconnects.delete(evicted);
    }
  }

  private rememberExpectedDisconnect(
    peerId: Guid,
    transportId: Guid,
    direction: TransportDirection,
  ) {
    const key = this.buildExpectedDisconnectKey(transportId, direction);
    if (!this.expectedDisconnects.has(key)) {
      this.expectedDisconnectOrder.push(key);
    }
    this.expectedDisconnects.set(key, {
      peerId,
      direction,
    });
    this.trimExpectedDisconnects();
  }

  private consumeExpectedDisconnectPeerIds(
    transportId: Guid,
    directions: TransportDirection[],
  ) {
    const peerIds = new Set<Guid>();
    for (const direction of directions) {
      const key = this.buildExpectedDisconnectKey(transportId, direction);
      const expected = this.expectedDisconnects.get(key);
      if (!expected) {
        continue;
      }
      this.expectedDisconnects.delete(key);
      peerIds.add(expected.peerId);
    }
    return peerIds;
  }

  private getPeerTransportIdForServer(params: {
    peer: JoinedPeer;
    direction: TransportDirection;
    serverId: Guid;
  }) {
    const { peer, direction, serverId } = params;
    if (direction === "ingress") {
      return peer.transportIngress[serverId];
    }
    return peer.transportEgress[serverId];
  }

  private assertCreateTransportRoomMatch(params: {
    peer: JoinedPeer;
    room: string;
    direction: TransportDirection;
    context: CreateTransportContext;
  }) {
    const { peer, room, direction, context } = params;
    if (!room) {
      throw new PeerStateError(
        buildPeerFailure({
          context,
          peer,
          expectedRoomState: "joined",
          reason: `${direction} transport creation requires a non-empty room name`,
        }),
      );
    }
    if (peer.room !== room) {
      throw new PeerStateError(
        buildPeerFailure({
          context,
          peer,
          expectedRoomState: "joined",
          reason: `peer attempted to create ${direction} transport for another room`,
          expectedRoom: room,
        }),
      );
    }
  }

  private assertNoDuplicateTransportRequest(params: {
    peer: JoinedPeer;
    direction: TransportDirection;
    serverId: Guid;
    context: CreateTransportContext;
  }) {
    const { peer, direction, serverId, context } = params;
    const existingTransportId = this.getPeerTransportIdForServer({
      peer,
      direction,
      serverId,
    });
    if (!existingTransportId) {
      return;
    }

    throw new PeerStateError(
      buildPeerFailure({
        context,
        peer,
        expectedRoomState: "joined",
        reason:
          direction === "ingress"
            ? "duplicate ingress transport request for this room"
            : "duplicate egress transport request for this room/server",
        details: [
          `${direction === "ingress" ? "ingress" : "egress"}Id=${serverId}`,
          `existingTransportId=${existingTransportId}`,
        ],
      }),
    );
  }

  private assertConnectTransportOwnership(params: {
    peer: JoinedPeer;
    direction: TransportDirection;
    serverId: Guid;
    providedTransportId: Guid;
  }) {
    const { peer, direction, serverId, providedTransportId } = params;
    const expectedTransportId = this.getPeerTransportIdForServer({
      peer,
      direction,
      serverId,
    });
    if (!expectedTransportId) {
      throw new PeerStateError(
        buildPeerFailure({
          context: "signaling.connectPeerTransport",
          peer,
          expectedRoomState: "joined",
          reason: `${direction} transport was not created before connect request`,
          details:
            direction === "ingress"
              ? [
                  `serverType=ingress`,
                  `providedTransportId=${providedTransportId}`,
                  `ingressId=${serverId}`,
                ]
              : [
                  `serverType=egress`,
                  `providedTransportId=${providedTransportId}`,
                  `targetEgress=${serverId}`,
                ],
        }),
      );
    }

    if (expectedTransportId !== providedTransportId) {
      throw new PeerStateError(
        buildPeerFailure({
          context: "signaling.connectPeerTransport",
          peer,
          expectedRoomState: "joined",
          reason:
            direction === "ingress"
              ? "ingress transport id mismatch; requested transport does not belong to peer"
              : "egress transport id mismatch; requested transport does not belong to peer",
          details:
            direction === "ingress"
              ? [
                  `serverType=ingress`,
                  `expectedTransportId=${expectedTransportId}`,
                  `providedTransportId=${providedTransportId}`,
                ]
              : [
                  `serverType=egress`,
                  `expectedTransportId=${expectedTransportId}`,
                  `providedTransportId=${providedTransportId}`,
                  `targetEgress=${serverId}`,
                ],
        }),
      );
    }
  }

  private handleCreatedWebRTCTransport(params: {
    serverId: Guid;
    direction: "ingress" | "egress";
    context: "createdWebRTCIngressTransport" | "createdWebRTCEgressTransport";
    message:
      | MediaInboundMessageMap["createdWebRTCIngressTransport"]
      | MediaInboundMessageMap["createdWebRTCEgressTransport"];
    transportDetailsStore: Map<Guid, WebRTCTransportDetails>;
  }) {
    const peerId = this.context.peerState.requirePeerIdByOrigin(
      params.message.originId,
      params.context,
    );
    const attached = this.context.sessions.attachTransport(
      peerId,
      params.serverId as Guid,
      params.message.transportId,
      params.direction,
    );
    if (!attached) {
      const peer = this.context.peerState.requirePeer(peerId, params.context);
      const directionLabel =
        params.direction === "ingress" ? "ingress" : "egress";
      throw new PeerStateError(
        buildPeerFailure({
          context: `signaling.${params.context}`,
          peer,
          expectedRoomState: "joined",
          reason: `failed to attach ${directionLabel} transport mapping after media response`,
          details: [
            `${directionLabel}Id=${params.serverId}`,
            `transportId=${params.message.transportId}`,
          ],
        }),
      );
    }

    const transportDetails: WebRTCTransportDetails = {
      iceParameters: params.message.iceParameters,
      iceCandidates: params.message.iceCandidates,
      dtlsParameters: params.message.dtlsParameters,
      sctpParameters: params.message.sctpParameters,
    };
    params.transportDetailsStore.set(
      params.message.transportId,
      transportDetails,
    );
    const details = buildTransportDetailsMessage(
      params.message.transportId,
      transportDetails,
    );
    return {
      peerId,
      details,
    };
  }

  /** Applies a created-ingress transport callback and returns details to the requesting peer. */
  createdWebRTCIngressTransport(
    ingressId: Guid,
    message: MediaInboundMessageMap["createdWebRTCIngressTransport"],
  ) {
    const { details } = this.handleCreatedWebRTCTransport({
      serverId: ingressId,
      direction: "ingress",
      context: "createdWebRTCIngressTransport",
      message,
      transportDetailsStore: this.context.ingressTransportDetails,
    });
    try {
      this.context.signalingMessenger.sendWebsocketMessage(
        message.originId,
        "createdIngress",
        details,
      );
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "deliveryUnavailable",
        message:
          "failed to deliver createdWebRTCIngressTransport response to websocket",
        cause: error,
      });
    }
  }

  /**
   * Applies a created-egress transport callback, responds to the requester, and
   * reevaluates room egress readiness for room-level notifications.
   */
  createdWebRTCEgressTransport(
    egressId: Guid,
    message: MediaInboundMessageMap["createdWebRTCEgressTransport"],
  ) {
    const { peerId, details } = this.handleCreatedWebRTCTransport({
      serverId: egressId,
      direction: "egress",
      context: "createdWebRTCEgressTransport",
      message,
      transportDetailsStore: this.context.egressTransportDetails,
    });
    try {
      this.context.signalingMessenger.sendWebsocketMessage(
        message.originId,
        "createdEgress",
        buildCreatedEgressMessage(details, egressId),
      );
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "deliveryUnavailable",
        message:
          "failed to deliver createdWebRTCEgressTransport response to websocket",
        cause: error,
      });
    }

    const peer = this.context.peers.get(peerId);
    if (peer?.room) {
      this.context.room.maybeNotifyRoomEgressReady(peer.room);
    }
  }

  /** Delivers ingress connect-ack to the requester. */
  connectedWebRTCIngressTransport(
    message: MediaInboundMessageMap["connectedWebRTCIngressTransport"],
  ) {
    try {
      this.context.signalingMessenger.sendWebsocketMessage(
        message.originId,
        "connectedIngress",
        buildConnectedIngressMessage(),
      );
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "deliveryUnavailable",
        message: "failed to deliver connectedWebRTCIngressTransport response",
        cause: error,
      });
    }
  }

  /** Delivers egress connect-ack to the requester. */
  connectedWebRTCEgressTransport(
    message: MediaInboundMessageMap["connectedWebRTCEgressTransport"],
  ) {
    try {
      this.context.signalingMessenger.sendWebsocketMessage(
        message.originId,
        "connectedEgress",
        buildConnectedEgressMessage(),
      );
    } catch (error) {
      throw RecoverableNetsocketCommandError.wrap({
        kind: "deliveryUnavailable",
        message: "failed to deliver connectedWebRTCEgressTransport response",
        cause: error,
      });
    }
  }

  private cleanupPeerTransportDirection(params: {
    peer: Peer;
    channel: "ingress" | "egress";
    transportsByServer: Record<string, Guid>;
    transportDetails: Map<Guid, WebRTCTransportDetails>;
  }) {
    const { peer, channel, transportsByServer, transportDetails } = params;
    for (const serverId in transportsByServer) {
      const transportId = transportsByServer[serverId];
      this.rememberExpectedDisconnect(peer.id, transportId, channel);
      transportDetails.delete(transportId);
    }
  }

  /**
   * Clears runtime transport bindings for a peer and returns transport ids that
   * should be disconnected at the media-server edge.
   */
  cleanupPeerTransports(peer: Peer, mode: "leaving" | "closing") {
    const ingressTransportIds = Object.values(peer.transportIngress);
    const egressTransportIds = Object.values(peer.transportEgress);
    this.cleanupPeerTransportDirection({
      peer,
      channel: "ingress",
      transportsByServer: peer.transportIngress,
      transportDetails: this.context.ingressTransportDetails,
    });
    this.cleanupPeerTransportDirection({
      peer,
      channel: "egress",
      transportsByServer: peer.transportEgress,
      transportDetails: this.context.egressTransportDetails,
    });

    this.context.sessions.clearTransportsForPeer(peer);

    const producerIds = new Set<Guid>(
      this.context.producers.getPeerProducerIds(peer.id),
    );
    if (producerIds.size) {
      this.context.pipeRegistry.stripProducersFromPipes(producerIds);
    }

    const clearedPeerBase = clearPeerRuntimeBindings({
      peer,
      context: "signaling.cleanupPeerTransports",
    });
    const updatedPeer =
      mode === "leaving"
        ? applyPeerEvent({
            peer: clearedPeerBase,
            event: { type: "mediaCleared" },
            context: "cleanupPeerTransports",
          }).updatedPeer
        : clearedPeerBase;

    assertValidPeerInvariant(updatedPeer, "signaling.cleanupPeerTransports");
    this.context.peerState.savePeer(updatedPeer);
    return {
      ingressTransportIds,
      egressTransportIds,
    };
  }

  /**
   * Applies a transport disconnect callback and reconciles peer/session indexes.
   */
  disconnectedWebRTCTransport(
    message: MediaInboundMessageMap["disconnectedWebRTCTransport"],
  ) {
    const mappedPeerId = message.originId
      ? this.context.sessions.getPeerIdByOrigin(message.originId)
      : undefined;
    const ingressPeerId = this.context.sessions.getPeerIdByTransport(
      message.transportId,
      "ingress",
    );
    const egressPeerId = this.context.sessions.getPeerIdByTransport(
      message.transportId,
      "egress",
    );
    const directions: Array<"ingress" | "egress"> = [message.direction];
    let removedAnyTransportBinding = false;
    const expectedDisconnectPeerIds = this.consumeExpectedDisconnectPeerIds(
      message.transportId,
      directions,
    );

    for (const direction of directions) {
      const peerId =
        mappedPeerId ??
        (direction === "ingress" ? ingressPeerId : egressPeerId);
      if (!peerId) {
        continue;
      }
      const removed = this.context.sessions.removeTransportFromPeer(
        peerId,
        message.transportId,
        direction,
      );
      if (removed) {
        removedAnyTransportBinding = true;
      }
    }

    if (message.direction === "ingress") {
      this.context.sessions.dropTransportMapping(
        message.transportId,
        "ingress",
      );
      this.context.ingressTransportDetails.delete(message.transportId);
    }
    if (message.direction === "egress") {
      this.context.sessions.dropTransportMapping(message.transportId, "egress");
      this.context.egressTransportDetails.delete(message.transportId);
    }

    const disconnectedPeerId =
      mappedPeerId ??
      ingressPeerId ??
      egressPeerId ??
      expectedDisconnectPeerIds.values().next().value;
    if (!disconnectedPeerId) {
      this.context.recordDiagnostic({
        severity: "warn",
        category: "transportLifecycle",
        message: "disconnected transport had no peer mapping",
        details: `transportId=${message.transportId}, direction=${message.direction}, originId=${message.originId || "unknown"}`,
        context: {
          transportId: message.transportId,
          direction: message.direction,
          originId: message.originId || "unknown",
        },
      });
      tracePeerLifecycle("transport_disconnect_missing_mapping", {
        transportId: message.transportId,
        direction: message.direction,
        originId: message.originId || "unknown",
      });
      return;
    }
    if (
      !removedAnyTransportBinding &&
      ingressPeerId === undefined &&
      egressPeerId === undefined &&
      expectedDisconnectPeerIds.has(disconnectedPeerId)
    ) {
      return;
    }
    const hadTrackedTransport =
      removedAnyTransportBinding ||
      ingressPeerId !== undefined ||
      egressPeerId !== undefined;
    if (!hadTrackedTransport) {
      this.context.recordDiagnostic({
        severity: "warn",
        category: "transportLifecycle",
        message: "stale disconnected transport callback ignored",
        details: `transportId=${message.transportId}, direction=${message.direction}, originId=${message.originId || "unknown"}, peerId=${disconnectedPeerId}`,
        context: {
          transportId: message.transportId,
          direction: message.direction,
          originId: message.originId || "unknown",
          peerId: disconnectedPeerId,
        },
      });
      tracePeerLifecycle("transport_disconnect_stale_callback", {
        transportId: message.transportId,
        direction: message.direction,
        originId: message.originId || "unknown",
        peerId: disconnectedPeerId,
      });
      return;
    }

    if (!this.context.sessions.isPeerClosing(disconnectedPeerId)) {
      const peer = this.context.peers.get(disconnectedPeerId);
      if (peer) {
        assertValidPeerInvariant(peer, "signaling.disconnectedWebRTCTransport");
      }

      if (
        peer &&
        isPeerMediaReady(peer) &&
        canApplyPeerEvent(peer, "mediaFailedReported")
      ) {
        const { updatedPeer } = applyPeerEvent({
          peer,
          event: { type: "mediaFailedReported" },
          context: "disconnectedWebRTCTransport",
        });
        this.context.peerState.savePeer(updatedPeer);
      }
    }

    if (
      this.context.sessions.isPeerClosing(disconnectedPeerId) &&
      !this.context.sessions.hasAnyTransports(disconnectedPeerId)
    ) {
      this.context.sessions.removePeer(disconnectedPeerId);
    }
  }

  /** Requests ingress transport creation for a joined peer. */
  createIngressTransport(
    peerId: Guid,
    room: string,
    sctpOptions: NumSctpStreams,
    rtpCapabilities: RtpCapabilities,
  ) {
    const transportingPeer = this.context.peerState.requireAttachedPeer(
      peerId,
      "createIngressTransport",
    );
    this.assertCreateTransportRoomMatch({
      peer: transportingPeer,
      room,
      direction: "ingress",
      context: "signaling.createIngressTransport",
    });

    const ingressId = transportingPeer.ingress;
    const updatedPeer = this.context.peerState.withRtpCapabilities(
      transportingPeer,
      rtpCapabilities,
    );
    this.context.peerState.savePeer(updatedPeer);

    this.assertNoDuplicateTransportRequest({
      peer: updatedPeer,
      direction: "ingress",
      serverId: ingressId,
      context: "signaling.createIngressTransport",
    });

    this.context.signalingMessenger.sendNetsocketMessage(
      ingressId,
      "ingress",
      "createWebRTCIngressTransport",
      buildCreateWebRTCIngressTransportMessage({
        originId: updatedPeer.transportSignal,
        sctpOptions,
        room,
      }),
    );
  }

  /** Requests egress transport creation for a joined peer + destination egress server. */
  createEgressTransport(
    peerId: Guid,
    room: string,
    sctpOptions: NumSctpStreams,
    rtpCapabilities: RtpCapabilities,
    destinationServer: Guid,
  ) {
    const transportingPeer = this.context.peerState.requireAttachedPeer(
      peerId,
      "createEgressTransport",
    );
    this.assertCreateTransportRoomMatch({
      peer: transportingPeer,
      room,
      direction: "egress",
      context: "signaling.createEgressTransport",
    });

    const updatedPeer = this.context.peerState.withRtpCapabilities(
      transportingPeer,
      rtpCapabilities,
    );
    this.context.peerState.savePeer(updatedPeer);

    this.assertNoDuplicateTransportRequest({
      peer: updatedPeer,
      direction: "egress",
      serverId: destinationServer,
      context: "signaling.createEgressTransport",
    });

    this.context.signalingMessenger.sendNetsocketMessage(
      destinationServer,
      "egress",
      "createWebRTCEgressTransport",
      buildCreateWebRTCEgressTransportMessage({
        originId: updatedPeer.transportSignal,
        sctpOptions,
        room,
      }),
    );
  }

  /** Requests DTLS connect for an existing ingress or egress transport. */
  connectPeerTransport(
    peerId: Guid,
    transportId: Guid,
    serverType: "ingress" | "egress",
    dtlsParameters: DtlsParameters,
    remoteEgress?: Guid,
  ) {
    const peer = this.context.peerState.requireAttachedPeer(
      peerId,
      "connectPeerTransport",
    );

    if (serverType === "ingress") {
      this.assertConnectTransportOwnership({
        peer,
        direction: "ingress",
        serverId: peer.ingress,
        providedTransportId: transportId,
      });
      this.context.signalingMessenger.sendNetsocketMessage(
        peer.ingress,
        "ingress",
        "connectWebRTCIngressTransport",
        buildConnectWebRTCTransportMessage({
          originId: peer.transportSignal,
          transportId,
          dtlsParameters,
        }),
      );
      return;
    }

    if (!remoteEgress) {
      throw new PeerStateError(
        "Missing remote egress target on connectPeerTransport",
      );
    }

    this.assertConnectTransportOwnership({
      peer,
      direction: "egress",
      serverId: remoteEgress,
      providedTransportId: transportId,
    });
    this.context.signalingMessenger.sendNetsocketMessage(
      remoteEgress,
      "egress",
      "connectWebRTCEgressTransport",
      buildConnectWebRTCTransportMessage({
        originId: peer.transportSignal,
        transportId,
        dtlsParameters,
      }),
    );
  }
}
