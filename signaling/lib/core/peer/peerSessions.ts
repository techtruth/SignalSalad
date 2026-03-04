import type { Guid, Peer } from "../../../../types/baseTypes.d.ts";
import {
  bindPeerTransport,
  unbindPeerTransportById,
} from "./peerStateMachine.js";

/** Transport direction used by peer session transport indexes. */
export type TransportDirection = "ingress" | "egress";

/**
 * In-memory index for peer session topology.
 *
 * Keeps cross-reference maps synchronized for room membership, transport ownership,
 * and signaling-origin lookups so higher-level lifecycle flows can remain declarative.
 */
export class PeerSessions {
  private peers: Map<Guid, Peer>;
  private originToPeerId: Map<Guid, Guid>;
  private ingressTransportToPeerId: Map<Guid, Guid>;
  private egressTransportToPeerId: Map<Guid, Guid>;
  private roomPeers: Map<string, Set<Guid>>;
  private peerRooms: Map<Guid, Set<string>>;
  private closingPeers: Set<Guid>;

  /**
   * Creates a peer session index.
   *
   * @param peers - Optional pre-existing peer map (shared by reference).
   */
  constructor(peers?: Map<Guid, Peer>) {
    this.peers = peers ?? new Map<Guid, Peer>();
    this.originToPeerId = new Map();
    this.ingressTransportToPeerId = new Map();
    this.egressTransportToPeerId = new Map();
    this.roomPeers = new Map();
    this.peerRooms = new Map();
    this.closingPeers = new Set();
  }

  // Peer storage ------------------------------------------------------------

  /**
   * Returns the underlying mutable peer map.
   *
   * @returns Peer map keyed by peer id.
   */
  getPeerMap() {
    return this.peers;
  }

  /**
   * Looks up one peer record by id.
   *
   * @param peerId - Peer id.
   * @returns Peer record or `undefined`.
   */
  getPeer(peerId: Guid) {
    return this.peers.get(peerId);
  }

  /**
   * Upserts a peer record into the index.
   *
   * @param peer - Peer record.
   * @returns `void`.
   */
  savePeer(peer: Peer) {
    this.peers.set(peer.id, peer);
  }

  /**
   * Returns total peers currently stored.
   *
   * @returns Number of peers.
   */
  getPeerCount() {
    return this.peers.size;
  }

  // Origins -----------------------------------------------------------------

  /**
   * Binds websocket origin id to peer id.
   *
   * @param originId - Websocket transport id/origin id.
   * @param peerId - Peer id.
   * @returns `void`.
   */
  setOrigin(originId: Guid, peerId: Guid) {
    this.originToPeerId.set(originId, peerId);
  }

  /**
   * Resolves peer id by websocket origin id.
   *
   * @param originId - Websocket transport id/origin id.
   * @returns Peer id or `undefined`.
   */
  getPeerIdByOrigin(originId: Guid) {
    return this.originToPeerId.get(originId);
  }

  /**
   * Removes websocket origin mapping.
   *
   * @param originId - Websocket transport id/origin id.
   * @returns `void`.
   */
  clearOrigin(originId: Guid) {
    this.originToPeerId.delete(originId);
  }

  // Rooms -------------------------------------------------------------------

  /**
   * Adds peer membership to a room index.
   *
   * @param peerId - Peer id.
   * @param room - Room id.
   * @returns `void`.
   */
  addPeerToRoom(peerId: Guid, room: string) {
    let peersInRoom = this.roomPeers.get(room);
    if (!peersInRoom) {
      peersInRoom = new Set();
      this.roomPeers.set(room, peersInRoom);
    }
    peersInRoom.add(peerId);

    let roomsForPeer = this.peerRooms.get(peerId);
    if (!roomsForPeer) {
      roomsForPeer = new Set();
      this.peerRooms.set(peerId, roomsForPeer);
    }
    roomsForPeer.add(room);
  }

  /**
   * Removes peer membership from one room index.
   *
   * @param peerId - Peer id.
   * @param room - Room id.
   * @returns `void`.
   */
  removePeerFromRoom(peerId: Guid, room: string) {
    const peersInRoom = this.roomPeers.get(room);
    if (peersInRoom) {
      peersInRoom.delete(peerId);
      if (peersInRoom.size === 0) {
        this.roomPeers.delete(room);
      }
    }
    const roomsForPeer = this.peerRooms.get(peerId);
    if (roomsForPeer) {
      roomsForPeer.delete(room);
      if (roomsForPeer.size === 0) {
        this.peerRooms.delete(peerId);
      }
    }
  }

  /**
   * Removes peer membership from all indexed rooms.
   *
   * @param peerId - Peer id.
   * @returns List of rooms from which the peer was removed.
   */
  clearPeerRooms(peerId: Guid) {
    const clearedRooms = new Array<string>();
    const roomsForPeer = this.peerRooms.get(peerId);
    if (!roomsForPeer) {
      return clearedRooms;
    }
    for (const room of roomsForPeer) {
      const peersInRoom = this.roomPeers.get(room);
      if (peersInRoom) {
        peersInRoom.delete(peerId);
        if (peersInRoom.size === 0) {
          this.roomPeers.delete(room);
        }
      }
      clearedRooms.push(room);
    }
    this.peerRooms.delete(peerId);
    return clearedRooms;
  }

  /**
   * Lists peer ids currently indexed in a room.
   *
   * @param room - Room id.
   * @returns Array of peer ids.
   */
  getRoomPeerIds(room: string): Guid[] {
    return Array.from(this.roomPeers.get(room) ?? []);
  }

  /**
   * Returns count of peers currently indexed in a room.
   *
   * @param room - Room id.
   * @returns Peer count.
   */
  getRoomPeerCount(room: string) {
    return this.roomPeers.get(room)?.size ?? 0;
  }

  // Transports --------------------------------------------------------------

  /**
   * Attaches one transport id to peer state and transport indexes.
   *
   * @param peerId - Peer id.
   * @param serverId - Media server id owning the transport.
   * @param transportId - Transport id.
   * @param direction - Transport direction.
   * @returns `true` when peer exists and mapping was applied.
   */
  attachTransport(
    peerId: Guid,
    serverId: Guid,
    transportId: Guid,
    direction: TransportDirection,
  ) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return false;
    }
    const updatedPeer = bindPeerTransport({
      peer,
      direction,
      serverId,
      transportId,
      context: "peerSessions.attachTransport",
    });
    this.peers.set(peerId, updatedPeer);
    if (direction === "ingress") {
      this.ingressTransportToPeerId.set(transportId, peerId);
    } else {
      this.egressTransportToPeerId.set(transportId, peerId);
    }
    return true;
  }

  /**
   * Detaches one transport from peer state and reverse indexes.
   *
   * @param peerId - Peer id.
   * @param transportId - Transport id.
   * @param direction - Transport direction.
   * @returns `true` when a matching transport mapping was removed.
   */
  removeTransportFromPeer(
    peerId: Guid,
    transportId: Guid,
    direction: TransportDirection,
  ) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return false;
    }
    const { updatedPeer, removed } = unbindPeerTransportById({
      peer,
      direction,
      transportId,
      context: "peerSessions.removeTransportFromPeer",
    });
    if (removed) {
      this.peers.set(peerId, updatedPeer);
      this.dropTransportMapping(transportId, direction);
    }
    return removed;
  }

  /**
   * Removes reverse transport->peer mapping for a direction.
   *
   * @param transportId - Transport id.
   * @param direction - Transport direction.
   * @returns `void`.
   */
  dropTransportMapping(transportId: Guid, direction: TransportDirection) {
    if (direction === "ingress") {
      this.ingressTransportToPeerId.delete(transportId);
    } else {
      this.egressTransportToPeerId.delete(transportId);
    }
  }

  /**
   * Resolves peer id by transport id and direction.
   *
   * @param transportId - Transport id.
   * @param direction - Transport direction.
   * @returns Peer id or `undefined`.
   */
  getPeerIdByTransport(
    transportId: Guid,
    direction: TransportDirection,
  ): Guid | undefined {
    return direction === "ingress"
      ? this.ingressTransportToPeerId.get(transportId)
      : this.egressTransportToPeerId.get(transportId);
  }

  /**
   * Clears ingress/egress reverse transport mappings for a peer.
   *
   * @param peer - Peer record.
   * @returns `void`.
   */
  clearTransportsForPeer(peer: Peer) {
    for (const transportId of Object.values(peer.transportIngress)) {
      this.ingressTransportToPeerId.delete(transportId);
    }
    for (const transportId of Object.values(peer.transportEgress)) {
      this.egressTransportToPeerId.delete(transportId);
    }
  }

  /**
   * Removes a peer and clears all related indexes.
   *
   * @param peerId - Peer id.
   * @returns Removed peer when found.
   */
  removePeer(peerId: Guid) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return undefined;
    }
    this.peers.delete(peerId);
    this.closingPeers.delete(peerId);
    this.clearOrigin(peer.transportSignal);
    this.clearTransportsForPeer(peer);
    this.clearPeerRooms(peerId);
    return peer;
  }

  /**
   * Marks a peer as entering teardown to suppress duplicate cleanup.
   *
   * @param peerId - Peer id.
   * @returns `void`.
   */
  markPeerClosing(peerId: Guid) {
    this.closingPeers.add(peerId);
  }

  /**
   * Checks whether a peer is currently marked as closing.
   *
   * @param peerId - Peer id.
   * @returns `true` when peer is in closing set.
   */
  isPeerClosing(peerId: Guid) {
    return this.closingPeers.has(peerId);
  }

  /**
   * Checks if a peer still has any ingress/egress transport bindings.
   *
   * @param peerId - Peer id.
   * @returns `true` when any transport mapping exists.
   */
  hasAnyTransports(peerId: Guid) {
    const peer = this.peers.get(peerId);
    if (!peer) {
      return false;
    }
    return (
      Object.keys(peer.transportIngress).length > 0 ||
      Object.keys(peer.transportEgress).length > 0
    );
  }

  /**
   * Returns a plain-object snapshot of origin->peer mappings.
   *
   * @returns Origin mapping object for diagnostics/tests.
   */
  getOriginIndex() {
    return Object.fromEntries(this.originToPeerId);
  }

  /**
   * Returns a plain-object snapshot of egressTransport->peer mappings.
   *
   * @returns Egress transport index snapshot for diagnostics/tests.
   */
  getEgressTransportIndex() {
    return Object.fromEntries(this.egressTransportToPeerId);
  }
}
