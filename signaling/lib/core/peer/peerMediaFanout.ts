import type {
  Guid,
  MediaReadyPeer,
  Peer,
} from "../../../../types/baseTypes.d.ts";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import { buildCreateConsumerMessage } from "../../protocol/netsocketMessageBuilders.js";
import { buildPeerFailure, PeerStateError } from "./peerStateMachine.js";

/** Producer ownership + egress routing tuple used when planning consumer fanout. */
export type ProducerEntry = {
  producerPeerId: Guid;
  egressId: Guid;
  producerIds: Guid[];
};

/** Intermediate grouped shape used while building egress fanout plans. */
type ProducersByEgress = Record<Guid, { [producerPeerId: string]: Guid[] }[]>;

/**
 * Egress-specific consumer creation plan.
 *
 * Each plan entry lists all producer-id groups that should be consumed through
 * one egress server for a given consumer peer.
 */
export type ConsumerPlan = {
  egressId: Guid;
  producerIds: { [producerPeerId: string]: Guid[] }[];
};

const requireValue = <T>(value: T | undefined | null, message: string): T => {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
};

const planProducersByEgress = (entries: ProducerEntry[]): ProducersByEgress => {
  const grouped = {} as ProducersByEgress;
  for (const entry of entries) {
    if (!entry.producerIds.length) {
      continue;
    }
    if (!grouped[entry.egressId]) {
      grouped[entry.egressId] = [];
    }
    grouped[entry.egressId].push({
      [entry.producerPeerId]: entry.producerIds,
    });
  }
  return grouped;
};

/**
 * Converts producer entries into per-egress fanout plans.
 */
export const planConsumerFanout = (
  entries: ProducerEntry[],
): ConsumerPlan[] => {
  const grouped = planProducersByEgress(entries);
  return Object.entries(grouped).map(([egressId, producerIds]) => ({
    egressId,
    producerIds,
  }));
};

/** Room membership query surface used while collecting producer peers. */
export type PeerMediaFanoutSessionsPort = {
  getRoomPeerIds(room: string): Guid[];
};

/** Peer-state access used to enforce media-ready preconditions. */
export type PeerMediaFanoutStatePort = {
  requireMediaPeer(peerId: Guid, context: string): MediaReadyPeer;
};

/** Producer lookup API used to resolve room producer ids by media type. */
export type PeerMediaFanoutProducersPort = {
  getRoomPeerProducerIds(
    room: string,
    peerId: Guid,
    mediaType: "audio" | "video",
  ): Guid[];
};

/** Egress registry presence checks used before dispatching create-consumer commands. */
export type PeerMediaFanoutEgressRegistryPort = {
  has(serverId: Guid): boolean;
};

/** Dependencies used by `PeerMediaFanout` planning and dispatch flows. */
export type PeerMediaFanoutContext = {
  sessions: PeerMediaFanoutSessionsPort;
  peerState: PeerMediaFanoutStatePort;
  producers: PeerMediaFanoutProducersPort;
  egressRegistry: PeerMediaFanoutEgressRegistryPort;
  signalingMessenger: Pick<SignalingMessenger, "sendNetsocketMessage">;
};

/**
 * Owns media fanout planning + createConsumer dispatch for a room-media request.
 */
export class PeerMediaFanout {
  private readonly context: PeerMediaFanoutContext;

  constructor(context: PeerMediaFanoutContext) {
    this.context = context;
  }

  private assertPeerInRoom(params: {
    peer: Peer;
    expectedRoom: string;
    context: string;
    reason: string;
    details?: string[];
  }) {
    if (params.peer.room === params.expectedRoom) {
      return;
    }
    throw new PeerStateError(
      buildPeerFailure({
        context: params.context,
        peer: params.peer,
        expectedRoomState: "joined",
        expectedMediaState: "ready",
        reason: params.reason,
        expectedRoom: params.expectedRoom,
        details: params.details,
      }),
    );
  }

  /**
   * Collects peers in the room that currently have producers for the requested media type.
   */
  collectProducerPeersWithMedia(params: {
    consumerPeer: MediaReadyPeer;
    room: string;
    mediaType: "audio" | "video";
  }) {
    const producerPeers = new Array<Guid>();
    for (const producerPeerId of this.context.sessions.getRoomPeerIds(
      params.room,
    )) {
      if (params.consumerPeer.id === producerPeerId) {
        continue;
      }
      this.context.peerState.requireMediaPeer(
        producerPeerId,
        "consumeAllMedia",
      );
      const producerMedia = this.context.producers.getRoomPeerProducerIds(
        params.room,
        producerPeerId,
        params.mediaType,
      );
      if (producerMedia.length) {
        producerPeers.push(producerPeerId);
      }
    }
    return producerPeers;
  }

  /**
   * Validates room membership for producer/consumer peers and builds producer entry list.
   */
  collectProducerEntries(params: {
    requestingId: Guid;
    room: string;
    mediaType: "audio" | "video";
    producers: Guid[];
  }) {
    const context = "signaling.requestAllMediaForProducers";
    const consumerPeer = this.context.peerState.requireMediaPeer(
      params.requestingId,
      "requestAllMediaForProducers",
    );
    this.assertPeerInRoom({
      peer: consumerPeer,
      expectedRoom: params.room,
      context,
      reason: "consumer peer room does not match requested room",
      details: [`mediaType=${params.mediaType}`],
    });

    const producerEntries: ProducerEntry[] = [];
    for (const producerPeerId of params.producers) {
      const producerPeer = this.context.peerState.requireMediaPeer(
        producerPeerId,
        "requestAllMediaForProducers",
      );
      this.assertPeerInRoom({
        peer: producerPeer,
        expectedRoom: params.room,
        context,
        reason: "producer peer room does not match requested room",
        details: [
          `mediaType=${params.mediaType}`,
          `consumerPeerId=${params.requestingId}`,
        ],
      });
      const producerIds = this.context.producers.getRoomPeerProducerIds(
        params.room,
        producerPeerId,
        params.mediaType,
      );
      if (!producerIds.length) {
        continue;
      }
      producerEntries.push({
        producerPeerId,
        egressId: producerPeer.egress,
        producerIds,
      });
    }

    return { consumerPeer, producerEntries };
  }

  /**
   * Dispatches `createConsumer` requests using planned producer fanout grouped by egress.
   */
  dispatchConsumerRequests(params: {
    consumerPeer: MediaReadyPeer;
    room: string;
    mediaType: "audio" | "video";
    producerEntries: ProducerEntry[];
  }) {
    const rtpCaps = params.consumerPeer.deviceRTPCapabilities;
    for (const plan of planConsumerFanout(params.producerEntries)) {
      const egressId = plan.egressId;
      if (!this.context.egressRegistry.has(egressId)) {
        throw new PeerStateError(`Egress missing ${egressId}`);
      }
      const consumerTransportId = params.consumerPeer.transportEgress[egressId];
      const resolvedConsumerTransportId = requireValue(
        consumerTransportId,
        `Missing consumer transport for ${egressId}`,
      );
      const message = buildCreateConsumerMessage({
        kind: params.mediaType,
        consumerTransportId: resolvedConsumerTransportId,
        producerIds: plan.producerIds,
        room: params.room,
        rtpCaps,
      });
      this.context.signalingMessenger.sendNetsocketMessage(
        egressId,
        "egress",
        "createConsumer",
        message,
      );
    }
  }
}
