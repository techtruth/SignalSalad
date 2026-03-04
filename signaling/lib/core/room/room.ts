import type { Guid, JoinedPeer, Peer } from "../../../../types/baseTypes.d.ts";
import { buildCreateRouterGroupMessage } from "../../protocol/netsocketMessageBuilders.js";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import type { RoutingTableItems } from "../../protocol/signalingTypes.js";
import {
  buildRoomEgressReadyMessage,
  buildWebsocketErrorMessage,
} from "../../protocol/websocketResponseBuilders.js";

/** Room routing/readiness index surface consumed by `Room`. */
export type RoomRoutingPort = {
  getRoutingTable(): Map<string, RoutingTableItems>;
  onRoomUpdated(room: string): void;
  getOrCreateRoomRouting(room: string): RoutingTableItems;
  ensureRoomIngressRoute(room: string, ingressId: Guid): boolean;
  ensureRoomEgressRoute(room: string, egressId: Guid): boolean;
  deleteRoom(room: string): void;
  recordRoomEgressReadiness(room: string, ready: boolean): void;
  beginRoomEgressReadyBroadcast(room: string, egressServers: Guid[]): Set<Guid>;
  setRoomEgressReadyNotifiedPeers(room: string, notifiedPeers: Set<Guid>): void;
};

/** Peer membership queries used by room readiness checks and broadcasts. */
export type RoomMembershipPort = {
  getRoomPeerIds(room: string): Guid[];
  getPeer(peerId: Guid): Peer | undefined;
  requireAttachedPeer(peerId: Guid, context: string): JoinedPeer;
};

/** Dependencies used by room routing/readiness orchestration. */
export type RoomContext = {
  roomRouting: RoomRoutingPort;
  membership: RoomMembershipPort;
  signalingMessenger: SignalingMessenger;
};

/**
 * Coordinates room-level routing/readiness notifications and room join routing requests.
 */
export class Room {
  private readonly context: RoomContext;

  constructor(context: RoomContext) {
    this.context = context;
  }

  private getRoomEgressServers(room: string) {
    const routingTable = this.context.roomRouting.getRoutingTable();
    const routing = routingTable.get(room);
    return routing?.egress ?? [];
  }

  private isPeerEgressReady(peer: Peer, egressServers: Guid[]) {
    for (const egressId of egressServers) {
      if (!peer.transportEgress[egressId]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Recomputes room lifecycle/readiness after any routing membership update.
   *
   * @param room - Room id whose routing state changed.
   * @returns `void`.
   */
  onRoomUpdated(room: string) {
    this.context.roomRouting.onRoomUpdated(room);
    this.maybeNotifyRoomEgressReady(room);
  }

  /**
   * Reads the current routing item for one room.
   *
   * @param room - Room id.
   * @returns Existing routing item, or `undefined` when absent.
   */
  getRoomRouting(room: string): RoutingTableItems | undefined {
    return this.context.roomRouting.getRoutingTable().get(room);
  }

  /**
   * Returns room routing, creating an empty routing item when missing.
   *
   * @param room - Room id.
   * @returns Existing or newly created routing item.
   */
  getOrCreateRoomRouting(room: string): RoutingTableItems {
    return this.context.roomRouting.getOrCreateRoomRouting(room);
  }

  /**
   * Ensures ingress route membership for one room.
   *
   * @param room - Room id.
   * @param ingressId - Ingress media server id.
   * @returns `true` when route was added, `false` when already present.
   */
  ensureRoomIngressRoute(room: string, ingressId: Guid) {
    return this.context.roomRouting.ensureRoomIngressRoute(room, ingressId);
  }

  /**
   * Ensures egress route membership for one room.
   *
   * @param room - Room id.
   * @param egressId - Egress media server id.
   * @returns `true` when route was added, `false` when already present.
   */
  ensureRoomEgressRoute(room: string, egressId: Guid) {
    return this.context.roomRouting.ensureRoomEgressRoute(room, egressId);
  }

  /**
   * Persists room routing and triggers lifecycle/readiness recomputation.
   *
   * @param room - Room id.
   * @param routing - Full routing snapshot to persist.
   * @returns `void`.
   */
  saveRoomRouting(room: string, routing: RoutingTableItems) {
    this.context.roomRouting.getRoutingTable().set(room, routing);
    this.onRoomUpdated(room);
  }

  /**
   * Deletes room routing and associated readiness state.
   *
   * @param room - Room id.
   * @returns `void`.
   */
  destroyRoomRouting(room: string) {
    this.context.roomRouting.deleteRoom(room);
  }

  /**
   * Checks whether every joined peer has all required egress transports.
   *
   * @param room - Room id to evaluate.
   * @returns `true` when room has egress routes and all joined peers are transport-ready.
   */
  isRoomEgressReady(room: string) {
    const egressServers = this.getRoomEgressServers(room);
    if (!egressServers.length) {
      this.context.roomRouting.recordRoomEgressReadiness(room, false);
      return false;
    }
    const roomPeers = this.context.membership.getRoomPeerIds(room);
    if (!roomPeers.length) {
      this.context.roomRouting.recordRoomEgressReadiness(room, false);
      return false;
    }
    for (const peerId of roomPeers) {
      const peer = this.context.membership.getPeer(peerId);
      if (!peer || peer.roomState !== "joined") {
        this.context.roomRouting.recordRoomEgressReadiness(room, false);
        return false;
      }
      if (!this.isPeerEgressReady(peer, egressServers)) {
        this.context.roomRouting.recordRoomEgressReadiness(room, false);
        return false;
      }
    }
    this.context.roomRouting.recordRoomEgressReadiness(room, true);
    return true;
  }

  /**
   * Broadcasts `roomEgressReady` once per peer for the current egress signature.
   *
   * @param room - Room id to broadcast readiness for.
   * @returns `void`.
   */
  maybeNotifyRoomEgressReady(room: string) {
    if (!this.isRoomEgressReady(room)) {
      return;
    }
    const egressServers = this.getRoomEgressServers(room);
    const notified = this.context.roomRouting.beginRoomEgressReadyBroadcast(
      room,
      egressServers,
    );
    const roomPeerIds = this.context.membership.getRoomPeerIds(room);
    const roomPeerSet = new Set<Guid>(roomPeerIds);
    for (const peerId of [...notified]) {
      if (!roomPeerSet.has(peerId)) {
        notified.delete(peerId);
      }
    }
    const message = buildRoomEgressReadyMessage(room, egressServers);
    for (const peerId of roomPeerIds) {
      if (notified.has(peerId)) {
        continue;
      }
      const peer = this.context.membership.getPeer(peerId);
      if (!peer) {
        continue;
      }
      this.context.signalingMessenger.sendWebsocketMessage(
        peer.transportSignal,
        "roomEgressReady",
        message,
      );
      notified.add(peerId);
    }
    this.context.roomRouting.setRoomEgressReadyNotifiedPeers(room, notified);
  }

  /**
   * Validates room readiness for one peer operation.
   *
   * Emits a websocket error to the peer when the room is not ready.
   *
   * @param peerId - Peer id initiating the operation.
   * @param context - Caller context for diagnostics/error wording.
   * @returns `true` when room is ready, otherwise `false`.
   */
  ensureRoomEgressReady(peerId: Guid, context: string) {
    const peer = this.context.membership.requireAttachedPeer(peerId, context);
    const room = peer.room;
    if (!this.isRoomEgressReady(room)) {
      this.context.signalingMessenger.sendWebsocketMessage(
        peer.transportSignal,
        "error",
        buildWebsocketErrorMessage(
          "roomEgressNotReady",
          `Room ${room} is not ready for media (${context}).`,
        ),
      );
      return false;
    }
    return true;
  }

  /**
   * Requests router-group creation on one media server for a room join path.
   *
   * @param room - Room id.
   * @param wsTransportId - Peer websocket transport id used as origin.
   * @param serverType - Target media-server role (`ingress` or `egress`).
   * @param serverId - Target media-server id.
   * @returns `void`.
   */
  requestJoin(
    room: string,
    wsTransportId: Guid,
    serverType: "ingress" | "egress",
    serverId: Guid,
  ) {
    const message = buildCreateRouterGroupMessage(wsTransportId, room);
    this.context.signalingMessenger.sendNetsocketMessage(
      serverId,
      serverType,
      "createRouterGroup",
      message,
    );
  }
}
