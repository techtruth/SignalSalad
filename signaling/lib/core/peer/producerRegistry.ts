import type { Guid } from "../../../../types/baseTypes.d.ts";

/**
 * Canonical ownership tuple for a producer tracked by signaling.
 */
export type ProducerOwner = {
  peerId: Guid;
  room: string;
  mediaType: "audio" | "video";
};

type ReleasedProducerOwner = {
  peerId?: Guid;
  room?: string;
  mediaType?: "audio" | "video";
};

const MAX_RECENTLY_RELEASED_PRODUCERS = 4096;

/**
 * In-memory producer index used by signaling orchestration.
 *
 * It tracks producer ownership, room membership, and optional ingress affinity
 * so cleanup/fanout logic can resolve producers without scanning peer objects.
 */
export class ProducerRegistry {
  private owners: Map<Guid, ProducerOwner>;
  private ingressServers: Map<Guid, Guid>;
  private roomProducers: Map<string, Map<Guid, Set<Guid>>>;
  private peerProducers: Map<Guid, Set<Guid>>;
  private recentlyReleased: Map<Guid, ReleasedProducerOwner>;
  private recentlyReleasedOrder: Guid[];

  /** Creates an empty producer ownership/index registry. */
  constructor() {
    this.owners = new Map();
    this.ingressServers = new Map();
    this.roomProducers = new Map();
    this.peerProducers = new Map();
    this.recentlyReleased = new Map();
    this.recentlyReleasedOrder = [];
  }

  private trimRecentlyReleased() {
    while (
      this.recentlyReleasedOrder.length > MAX_RECENTLY_RELEASED_PRODUCERS
    ) {
      const evicted = this.recentlyReleasedOrder.shift();
      if (!evicted) {
        break;
      }
      this.recentlyReleased.delete(evicted);
    }
  }

  private markRecentlyReleased(
    producerId: Guid,
    owner?: Partial<ProducerOwner>,
  ) {
    if (!this.recentlyReleased.has(producerId)) {
      this.recentlyReleasedOrder.push(producerId);
    }
    this.recentlyReleased.set(producerId, {
      peerId: owner?.peerId,
      room: owner?.room,
      mediaType: owner?.mediaType,
    });
    this.trimRecentlyReleased();
  }

  // Recording ---------------------------------------------------------------

  /**
   * Registers producer ownership and optional ingress affinity for fanout planning.
   *
   * @param producerId - Producer id.
   * @param peerId - Owning peer id.
   * @param room - Room id.
   * @param mediaType - Producer media kind.
   * @param ingressServerId - Optional ingress server affinity.
   * @returns `void`.
   */
  recordProducer(
    producerId: Guid,
    peerId: Guid,
    room: string,
    mediaType: "audio" | "video",
    ingressServerId?: Guid,
  ) {
    this.owners.set(producerId, { peerId, room, mediaType });
    if (ingressServerId) {
      this.ingressServers.set(producerId, ingressServerId);
    }
    this.recordRoomProducer(room, peerId, producerId);
    let peerEntry = this.peerProducers.get(peerId);
    if (!peerEntry) {
      peerEntry = new Set<Guid>();
      this.peerProducers.set(peerId, peerEntry);
    }
    peerEntry.add(producerId);
  }

  // Room indexing -----------------------------------------------------------

  /**
   * Adds producer membership to room-scoped producer index.
   *
   * @param room - Room id.
   * @param peerId - Peer id.
   * @param producerId - Producer id.
   * @returns `void`.
   */
  recordRoomProducer(room: string, peerId: Guid, producerId: Guid) {
    let roomEntry = this.roomProducers.get(room);
    if (!roomEntry) {
      roomEntry = new Map<Guid, Set<Guid>>();
      this.roomProducers.set(room, roomEntry);
    }
    let peerEntry = roomEntry.get(peerId);
    if (!peerEntry) {
      peerEntry = new Set<Guid>();
      roomEntry.set(peerId, peerEntry);
    }
    peerEntry.add(producerId);
  }

  /**
   * Removes one producer from room-scoped producer index.
   *
   * @param room - Room id.
   * @param peerId - Peer id.
   * @param producerId - Producer id.
   * @returns `void`.
   */
  removeRoomProducer(room: string, peerId: Guid, producerId: Guid) {
    const roomEntry = this.roomProducers.get(room);
    if (!roomEntry) {
      return;
    }
    const peerEntry = roomEntry.get(peerId);
    if (!peerEntry) {
      return;
    }
    peerEntry.delete(producerId);
    if (peerEntry.size === 0) {
      roomEntry.delete(peerId);
    }
    if (roomEntry.size === 0) {
      this.roomProducers.delete(room);
    }
  }

  /**
   * Removes all producers indexed under a room and clears ownership mappings.
   *
   * @param room - Room id.
   * @returns `void`.
   */
  clearRoom(room: string) {
    const roomEntry = this.roomProducers.get(room);
    if (!roomEntry) {
      return;
    }

    for (const [peerId, producerIds] of roomEntry.entries()) {
      const peerEntry = this.peerProducers.get(peerId);
      for (const producerId of producerIds) {
        const owner = this.owners.get(producerId);
        this.markRecentlyReleased(producerId, owner);
        this.owners.delete(producerId);
        this.ingressServers.delete(producerId);
        peerEntry?.delete(producerId);
      }
      if (peerEntry && peerEntry.size === 0) {
        this.peerProducers.delete(peerId);
      }
    }

    this.roomProducers.delete(room);
  }

  // Lookups -----------------------------------------------------------------

  /**
   * Lists all producer ids currently owned by a peer.
   *
   * @param peerId - Peer id.
   * @returns Producer ids.
   */
  getPeerProducerIds(peerId: Guid): Guid[] {
    return Array.from(this.peerProducers.get(peerId) ?? []);
  }

  /**
   * Returns owner entries for all producers owned by a peer.
   *
   * @param peerId - Peer id.
   * @returns Producer ownership entries.
   */
  getPeerProducerEntries(peerId: Guid) {
    const entries = new Array<{
      producerId: Guid;
      room: string;
      mediaType: "audio" | "video";
    }>();
    const producerIds = this.peerProducers.get(peerId);
    if (!producerIds) {
      return entries;
    }
    for (const producerId of producerIds) {
      const owner = this.owners.get(producerId);
      if (!owner) {
        continue;
      }
      entries.push({
        producerId,
        room: owner.room,
        mediaType: owner.mediaType,
      });
    }
    return entries;
  }

  /**
   * Lists producer ids for one peer in one room, optionally filtered by media type.
   *
   * @param room - Room id.
   * @param peerId - Peer id.
   * @param mediaType - Optional media type filter.
   * @returns Producer ids matching query.
   */
  getRoomPeerProducerIds(
    room: string,
    peerId: Guid,
    mediaType?: "audio" | "video",
  ): Guid[] {
    const roomEntry = this.roomProducers.get(room);
    if (!roomEntry) {
      return [];
    }
    const peerEntry = roomEntry.get(peerId);
    if (!peerEntry) {
      return [];
    }
    if (!mediaType) {
      return Array.from(peerEntry);
    }
    return Array.from(peerEntry).filter((producerId) => {
      const owner = this.owners.get(producerId);
      return owner?.mediaType === mediaType;
    });
  }

  /**
   * Returns producer ids grouped by media type for a peer.
   *
   * @param peerId - Peer id.
   * @returns Map-like object keyed by media type.
   */
  getPeerMediaProducers(peerId: Guid) {
    const entries = this.getPeerProducerEntries(peerId);
    const result: Partial<Record<"audio" | "video", Guid[]>> = {};
    for (const entry of entries) {
      if (!result[entry.mediaType]) {
        result[entry.mediaType] = [];
      }
      result[entry.mediaType]?.push(entry.producerId);
    }
    return result;
  }

  // Release -----------------------------------------------------------------

  /**
   * Returns ownership tuple for one producer id.
   *
   * @param producerId - Producer id.
   * @returns Owner tuple or `undefined`.
   */
  getOwner(producerId: Guid) {
    return this.owners.get(producerId);
  }

  /**
   * Returns ingress server affinity for one producer when tracked.
   *
   * @param producerId - Producer id.
   * @returns Ingress server id or `undefined`.
   */
  getIngressServer(producerId: Guid) {
    return this.ingressServers.get(producerId);
  }

  /**
   * Removes a producer from all ownership and room indexes.
   *
   * @param producerId - Producer id.
   * @returns Previous owner tuple when one existed.
   */
  releaseProducer(producerId: Guid) {
    const owner = this.owners.get(producerId);
    this.markRecentlyReleased(producerId, owner);
    if (owner?.room) {
      this.removeRoomProducer(owner.room, owner.peerId, producerId);
    }
    if (owner?.peerId) {
      const peerEntry = this.peerProducers.get(owner.peerId);
      if (peerEntry) {
        peerEntry.delete(producerId);
        if (peerEntry.size === 0) {
          this.peerProducers.delete(owner.peerId);
        }
      }
    }
    this.owners.delete(producerId);
    this.ingressServers.delete(producerId);
    return owner;
  }

  /**
   * Returns whether a producer was released recently and may still emit late callbacks.
   *
   * @param producerId - Producer id.
   * @returns `true` when producer was recently released.
   */
  wasRecentlyReleased(producerId: Guid) {
    return this.recentlyReleased.has(producerId);
  }
}
