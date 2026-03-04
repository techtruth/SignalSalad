import type { ProducerOptions } from "mediasoup/types";

import type {
  Guid,
  MediaReadyPeer,
  MediaState,
  Peer,
  RoomState,
  JoinedPeer,
} from "../../../../types/baseTypes.d.ts";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import type {
  MediaInboundMessageMap,
  NsMessageMap,
  SignalingDiagnosticEvent,
} from "../../protocol/signalingIoValidation.js";
import { buildProducerClosedMessage } from "../../protocol/websocketResponseBuilders.js";
import { buildPeerFailure, PeerStateError } from "./peerStateMachine.js";
import { PeerMediaFanout } from "./peerMediaFanout.js";
import {
  buildCreateConsumerMessage,
  buildCreateMediaProducerMessage,
  buildProducerCloseMessage,
  buildSetProducerPausedMessage,
} from "../../protocol/netsocketMessageBuilders.js";
import type { MediaServerPipe } from "../../protocol/signalingTypes.js";

/** Diagnostic payload forwarded to shared signaling diagnostics (timestamp is injected by caller). */
export type DiagnosticEvent = SignalingDiagnosticEvent;

const requireValue = <T>(value: T | undefined | null, message: string): T => {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
};

const assertPeerInRoom = (params: {
  peer: Peer;
  expectedRoom: string;
  context: string;
  reason: string;
  expectedRoomState?: RoomState | RoomState[];
  expectedMediaState?: MediaState | MediaState[];
  details?: string[];
}) => {
  if (params.peer.room === params.expectedRoom) {
    return;
  }
  throw new PeerStateError(
    buildPeerFailure({
      context: params.context,
      peer: params.peer,
      expectedRoomState: params.expectedRoomState,
      expectedMediaState: params.expectedMediaState,
      reason: params.reason,
      expectedRoom: params.expectedRoom,
      details: params.details,
    }),
  );
};

/** Room membership query API used by media close/fanout notifications. */
export type PeerMediaSessionSessionsPort = {
  getRoomPeerIds(room: string): Guid[];
};

/** Producer ownership/index API required by media-session orchestration. */
export type PeerMediaSessionProducerPort = {
  getPeerProducerEntries(peerId: Guid): Array<{
    producerId: Guid;
    room: string;
    mediaType: "audio" | "video";
  }>;
  getIngressServer(producerId: Guid): Guid | undefined;
  getPeerProducerIds(peerId: Guid): Guid[];
  releaseProducer(producerId: Guid): unknown;
  getOwner(producerId: Guid):
    | {
        peerId: Guid;
        room: string;
        mediaType: "audio" | "video";
      }
    | undefined;
  wasRecentlyReleased(producerId: Guid): boolean;
  getRoomPeerProducerIds(
    room: string,
    peerId: Guid,
    mediaType?: "audio" | "video",
  ): Guid[];
};

/** Peer-state access helpers used to enforce join/media-ready preconditions. */
export type PeerMediaSessionStateAccessPort = {
  requireAttachedPeer: (peerId: Guid, context: string) => JoinedPeer;
  requireMediaPeer: (peerId: Guid, context: string) => MediaReadyPeer;
  requireMediaPeerByOrigin: (originId: Guid, context: string) => MediaReadyPeer;
};

/** Pipe registry hooks used to remove stale producer mappings from relay pipes. */
export type PeerMediaSessionPipeRegistryPort = {
  listPipes(): readonly MediaServerPipe[];
  stripProducersFromPipes: (producerIds: Set<Guid>) => void;
};

/** Egress connectivity checks required before media fanout dispatch. */
export type PeerMediaSessionEgressRegistryPort = {
  has(serverId: Guid): boolean;
};

/** Room-readiness checks required before create-consumer dispatch. */
export type PeerMediaSessionRoomPort = {
  ensureRoomEgressReady: (peerId: Guid, context: string) => boolean;
};

/** Dependencies used by peer media-session orchestration. */
export type PeerMediaSessionContext = {
  peers: Map<Guid, Peer>;
  sessions: PeerMediaSessionSessionsPort;
  producers: PeerMediaSessionProducerPort;
  egressRegistry: PeerMediaSessionEgressRegistryPort;
  room: PeerMediaSessionRoomPort;
  peerState: PeerMediaSessionStateAccessPort;
  pipeRegistry: PeerMediaSessionPipeRegistryPort;
  signalingMessenger: SignalingMessenger;
  recordDiagnostic: (event: DiagnosticEvent) => void;
};

/**
 * Owns peer media-session orchestration.
 *
 * Responsibilities:
 * - producer create/close/mute signaling
 * - consumer fanout planning and dispatch
 * - producer->egress mapping lookups from current room relay pipes
 */
export class PeerMediaSession {
  private readonly context: PeerMediaSessionContext;
  private readonly mediaFanout: PeerMediaFanout;

  constructor(context: PeerMediaSessionContext) {
    this.context = context;
    this.mediaFanout = new PeerMediaFanout({
      sessions: this.context.sessions,
      peerState: this.context.peerState,
      producers: this.context.producers,
      egressRegistry: this.context.egressRegistry,
      signalingMessenger: this.context.signalingMessenger,
    });
  }

  private requirePeer(peerId: Guid, context: string): Peer {
    const peer = this.context.peers.get(peerId);
    if (!peer) {
      throw new PeerStateError(`Missing peer ${peerId} on ${context}`);
    }
    return peer;
  }

  /**
   * Applies a server-side mute/unmute to all audio producers currently owned by a peer.
   */
  setPeerServerMute(peerId: Guid, muted: boolean) {
    const peer = this.context.peerState.requireAttachedPeer(
      peerId,
      "setPeerServerMute",
    );
    const producerEntries = this.context.producers
      .getPeerProducerEntries(peerId)
      .filter((entry) => entry.mediaType === "audio");

    if (producerEntries.length === 0) {
      throw new PeerStateError(
        buildPeerFailure({
          context: "signaling.setPeerServerMute",
          peer,
          expectedRoomState: "joined",
          reason: "peer has no audio producers to mute",
          details: [`muted=${muted}`],
        }),
      );
    }

    for (const entry of producerEntries) {
      const ingressServerId =
        this.context.producers.getIngressServer(entry.producerId) ??
        peer.ingress;
      requireValue(
        ingressServerId,
        `Missing ingress server for producer ${entry.producerId} on setPeerServerMute`,
      );
      this.context.signalingMessenger.sendNetsocketMessage(
        ingressServerId,
        "ingress",
        "setProducerPaused",
        buildSetProducerPausedMessage({
          producerId: entry.producerId,
          paused: muted,
        }),
      );
    }
  }

  /**
   * Sends producer-close to ingress and any egress servers currently relaying that producer.
   *
   * @param peer - Peer requesting producer close.
   * @param producerId - Producer id to close.
   * @param mediaType - Media type used in producer-close payload.
   * @returns `void`.
   */
  sendProducerCloseToMedia(peer: Peer, producerId: Guid, mediaType: string) {
    requireValue(producerId, "Missing producerId on sendProducerCloseToMedia");
    const joinedPeer = this.context.peerState.requireAttachedPeer(
      peer.id,
      "sendProducerCloseToMedia",
    );

    const ingressServerId =
      this.context.producers.getIngressServer(producerId) ?? joinedPeer.ingress;
    const message = buildProducerCloseMessage(
      joinedPeer.id,
      producerId,
      mediaType,
    );

    const sendProducerClose = (
      serverId: Guid,
      channel: "ingress" | "egress",
    ) => {
      this.context.signalingMessenger.sendNetsocketMessage(
        serverId,
        channel,
        "producerClose",
        message,
      );
    };

    if (ingressServerId) {
      sendProducerClose(ingressServerId, "ingress");
    }

    const egressServers = this.findEgressServersForProducer(producerId);
    egressServers.forEach((egressId) => {
      sendProducerClose(egressId, "egress");
    });
  }

  /**
   * Validates ownership and forwards producer-close intent to ingress and routed egress servers.
   */
  requestProducerClose(peerId: Guid, producerId: Guid, mediaType: string) {
    const peer = this.context.peerState.requireAttachedPeer(
      peerId,
      "requestProducerClose",
    );
    this.sendProducerCloseToMedia(peer, producerId, mediaType);
  }

  /**
   * Releases all producer ownership for a peer prior to teardown dispatch.
   * Late producerClosed callbacks are then treated as expected stale responses.
   */
  releasePeerProducersForCleanup(peerId: Guid) {
    const producerIds = this.context.producers.getPeerProducerIds(peerId);
    if (!producerIds.length) {
      return producerIds;
    }
    for (const producerId of producerIds) {
      this.context.producers.releaseProducer(producerId);
    }
    this.context.pipeRegistry.stripProducersFromPipes(
      new Set<Guid>(producerIds),
    );
    return producerIds;
  }

  private notifyProducerClosed(
    room: string,
    producerPeerId: Guid,
    producerId: Guid,
    mediaType: string,
  ) {
    for (const peerId of this.context.sessions.getRoomPeerIds(room)) {
      if (peerId === producerPeerId) {
        continue;
      }
      const peerData = this.requirePeer(peerId, "notifyProducerClosed");
      const message = buildProducerClosedMessage(
        producerPeerId,
        producerId,
        mediaType,
      );
      this.context.signalingMessenger.sendWebsocketMessage(
        peerData.transportSignal,
        "producerClosed",
        message,
      );
    }
  }

  /**
   * Applies producer-closed side effects from media callback into local indexes.
   *
   * @param producerId - Closed producer id.
   * @param mediaType - Media type from callback (may be empty).
   * @returns `void`.
   */
  applyProducerClosed(producerId: Guid, mediaType: string) {
    const owner = this.context.producers.getOwner(producerId);
    if (!owner) {
      if (this.context.producers.wasRecentlyReleased(producerId)) {
        return;
      }
      this.context.recordDiagnostic({
        severity: "warn",
        category: "producerLifecycle",
        message: "producerClosed received without producer owner mapping",
        details: `producerId=${producerId}, mediaType=${mediaType || "unknown"}`,
        context: {
          producerId,
          mediaType: mediaType || "unknown",
        },
      });
      return;
    }
    const resolvedType = mediaType || owner.mediaType || "video";
    this.notifyProducerClosed(
      owner.room,
      owner.peerId,
      producerId,
      resolvedType,
    );
    this.context.pipeRegistry.stripProducersFromPipes(
      new Set<Guid>([producerId]),
    );
    this.context.producers.releaseProducer(producerId);
  }

  /**
   * Applies a producer-closed callback from media and fanouts peer notifications.
   */
  producerClosed(message: MediaInboundMessageMap["producerClosed"]) {
    this.applyProducerClosed(message.producerId, message.mediaType);
  }

  /**
   * Resolves egress servers currently carrying relay pipes for a producer.
   *
   * @param producerId - Producer id.
   * @returns Set of egress server ids.
   */
  findEgressServersForProducer(producerId: Guid) {
    const servers = new Set<Guid>();
    for (const pipe of this.context.pipeRegistry.listPipes()) {
      if (pipe.producerIds?.includes(producerId)) {
        servers.add(pipe.egress);
      }
    }
    return servers;
  }

  /**
   * Verifies that a consumer request is valid for the current room/media state.
   */
  validateConsumeRequest(requestingPeerId: Guid, mediaType: "audio" | "video") {
    const peer = this.context.peerState.requireMediaPeer(
      requestingPeerId,
      `validateConsumeRequest:${mediaType}`,
    );
    const egressTransports = Object.keys(peer.transportEgress);
    if (!egressTransports.length) {
      throw new PeerStateError(
        buildPeerFailure({
          context: `signaling.validateConsumeRequest:${mediaType}`,
          peer,
          expectedRoomState: "joined",
          expectedMediaState: "ready",
          reason:
            "peer cannot consume media until at least one egress transport exists",
          details: [`requestedMediaType=${mediaType}`],
        }),
      );
    }
  }

  /**
   * Builds create-consumer payloads for all room peers consuming one producer.
   *
   * @param originId - Producer owner's websocket origin id.
   * @param producerId - Producer id.
   * @param kind - Media kind to consume.
   * @param egressId - Egress server id routing the producer.
   * @returns Create-consumer payload list, one per eligible consumer peer.
   */
  createConsumerPayload(
    originId: Guid,
    producerId: string,
    kind: "video" | "audio",
    egressId: string,
  ): NsMessageMap["createConsumer"][] {
    const producerPeer = this.context.peerState.requireMediaPeerByOrigin(
      originId,
      "createConsumerPayload",
    );
    const room = producerPeer.room;

    const messages = new Array<NsMessageMap["createConsumer"]>();
    for (const consumerPeerId of this.context.sessions.getRoomPeerIds(room)) {
      if (producerPeer.id === consumerPeerId) {
        continue;
      }

      const consumerPeerData = this.context.peerState.requireMediaPeer(
        consumerPeerId,
        "createConsumerPayload",
      );
      assertPeerInRoom({
        peer: consumerPeerData,
        expectedRoom: room,
        context: "signaling.createConsumerPayload",
        expectedRoomState: "joined",
        expectedMediaState: "ready",
        reason: "consumer peer room does not match producer room",
        details: [`producerPeerId=${producerPeer.id}`],
      });

      const consumerTransportId = requireValue(
        consumerPeerData.transportEgress[egressId],
        `Missing consumer egress transport for peer ${consumerPeerId} on ${egressId}`,
      );
      const producerIds = [{ [producerPeer.id]: [producerId as Guid] }];
      messages.push(
        buildCreateConsumerMessage({
          kind,
          consumerTransportId,
          producerIds,
          room,
          rtpCaps: consumerPeerData.deviceRTPCapabilities,
        }),
      );
    }

    return messages;
  }

  /**
   * Normalizes producer kind to room-media kinds used by signaling policy and fanout.
   */
  resolveProducerMediaKind(
    kind: ProducerOptions["kind"],
    context: string,
  ): "audio" | "video" {
    if (kind === "audio" || kind === "video") {
      return kind;
    }
    throw new PeerStateError(
      `Unsupported producer kind '${String(kind)}' on ${context}`,
    );
  }

  /**
   * Creates a producer on ingress for the media kind derived from producer options.
   */
  createProducer(
    peerId: Guid,
    transportId: Guid,
    producerOptions: ProducerOptions,
    requestId: string,
  ) {
    const mediaKind = this.resolveProducerMediaKind(
      producerOptions.kind,
      "createProducer",
    );
    this.sendMediaProducerOnIngress(
      peerId,
      transportId,
      producerOptions,
      requestId,
      mediaKind === "audio" ? "createAudioProducer" : "createVideoProducer",
    );
    return mediaKind;
  }

  /**
   * Issues an audio producer-create command to the peer's ingress media server.
   */
  createAudioProducer(
    peerId: Guid,
    transportId: Guid,
    producerOptions: ProducerOptions,
    requestId: string,
  ) {
    this.sendMediaProducerOnIngress(
      peerId,
      transportId,
      producerOptions,
      requestId,
      "createAudioProducer",
    );
  }

  /**
   * Issues a video producer-create command to the peer's ingress media server.
   */
  createVideoProducer(
    peerId: Guid,
    transportId: Guid,
    producerOptions: ProducerOptions,
    requestId: string,
  ) {
    this.sendMediaProducerOnIngress(
      peerId,
      transportId,
      producerOptions,
      requestId,
      "createVideoProducer",
    );
  }

  private sendMediaProducerOnIngress(
    peerId: Guid,
    transportId: Guid,
    producerOptions: ProducerOptions,
    requestId: string,
    context: "createAudioProducer" | "createVideoProducer",
  ) {
    const producerPeer = this.context.peerState.requireMediaPeer(
      peerId,
      context,
    );
    const ingressId = producerPeer.ingress;
    const room = producerPeer.room;
    const rtpCaps = producerPeer.deviceRTPCapabilities;
    const egressId = producerPeer.egress;
    const message = buildCreateMediaProducerMessage({
      originId: producerPeer.transportSignal,
      transportId,
      producerOptions,
      room,
      rtpCapabilities: rtpCaps,
      egress: egressId,
      requestId,
    });
    this.context.signalingMessenger.sendNetsocketMessage(
      ingressId,
      "ingress",
      "createMediaProducer",
      message,
    );
  }

  /**
   * Plans and dispatches create-consumer commands for all producers of the requested media kind.
   */
  consumeAllMedia(requestingPeerId: Guid, type: "audio" | "video") {
    const consumerPeer = this.context.peerState.requireMediaPeer(
      requestingPeerId,
      "consumeAllMedia",
    );
    const room = consumerPeer.room;
    const producerPeers = this.mediaFanout.collectProducerPeersWithMedia({
      consumerPeer,
      room,
      mediaType: type,
    });
    if (!producerPeers.length) {
      return;
    }
    this.requestAllMediaForProducers(
      consumerPeer.id,
      room,
      type,
      producerPeers,
    );
  }

  /**
   * Dispatches create-consumer requests for one requester across selected producer peers.
   *
   * @param requestingId - Consumer peer id.
   * @param room - Room id.
   * @param type - Requested media type.
   * @param producers - Producer peer ids to fanout from.
   * @returns `void`.
   */
  requestAllMediaForProducers(
    requestingId: Guid,
    room: string,
    type: "audio" | "video",
    producers: Guid[],
  ) {
    const { consumerPeer, producerEntries } =
      this.mediaFanout.collectProducerEntries({
        requestingId,
        room,
        mediaType: type,
        producers,
      });
    this.mediaFanout.dispatchConsumerRequests({
      consumerPeer,
      room,
      mediaType: type,
      producerEntries,
    });
  }

  /**
   * Handles one room-media request flow by gating on room egress readiness first.
   */
  requestRoomMedia(request: {
    requestingPeerId: Guid;
    mediaType: "audio" | "video";
    context: string;
  }) {
    if (
      !this.context.room.ensureRoomEgressReady(
        request.requestingPeerId,
        request.context,
      )
    ) {
      return;
    }
    this.validateConsumeRequest(request.requestingPeerId, request.mediaType);
    this.consumeAllMedia(request.requestingPeerId, request.mediaType);
  }
}
