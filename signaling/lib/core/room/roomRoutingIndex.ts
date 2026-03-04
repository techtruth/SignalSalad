import type { Guid } from "../../../../types/baseTypes.d.ts";
import type { RoutingTableItems } from "../../protocol/signalingTypes.js";
import {
  applyRoomLifecycleEvent,
  createInitialRoomLifecycleState,
  type RoomLifecycleEvent,
  type RoomLifecycleState,
} from "./roomStateMachine.js";

const buildEgressReadySignature = (egressServers: Guid[]) => {
  return egressServers.slice().sort().join("|");
};

const createEmptyRoutingTableItem = (): RoutingTableItems => ({
  ingress: [],
  egress: [],
});

const ensureUniqueRoute = (servers: Guid[], serverId: Guid) => {
  if (servers.includes(serverId)) {
    return false;
  }
  servers.push(serverId);
  return true;
};

/** Aggregate room routing/readiness/lifecycle state owned by `RoomRoutingIndex`. */
export type RoomReadinessState = {
  routingTable: Map<string, RoutingTableItems>;
  roomEgressReadySignature: Map<string, string>;
  roomEgressReadyNotifiedPeers: Map<string, Set<Guid>>;
  roomLifecycle: Map<string, RoomLifecycleState>;
};

/**
 * Owns room routing/readiness state for signaling.
 *
 * Routing policy stays in pure functions, while this class keeps mutation and
 * lifecycle for room routing tables and readiness-notification indexes.
 */
export class RoomRoutingIndex {
  private readonly state: RoomReadinessState;

  /**
   * Creates a routing/readiness index, optionally reusing caller-owned maps.
   *
   * @param state - Optional externally provided map instances.
   */
  constructor(state?: Partial<RoomReadinessState>) {
    this.state = {
      routingTable: state?.routingTable ?? new Map<string, RoutingTableItems>(),
      roomEgressReadySignature:
        state?.roomEgressReadySignature ?? new Map<string, string>(),
      roomEgressReadyNotifiedPeers:
        state?.roomEgressReadyNotifiedPeers ?? new Map<string, Set<Guid>>(),
      roomLifecycle:
        state?.roomLifecycle ?? new Map<string, RoomLifecycleState>(),
    };
  }

  /**
   * Returns the mutable room routing table.
   *
   * @returns Routing table keyed by room id.
   */
  getRoutingTable() {
    return this.state.routingTable;
  }

  /**
   * Returns room routing, creating an empty routing entry if missing.
   *
   * @param room - Room id.
   * @returns Existing or newly created routing entry.
   */
  getOrCreateRoomRouting(room: string): RoutingTableItems {
    const existing = this.state.routingTable.get(room);
    if (existing) {
      return existing;
    }
    const created = createEmptyRoutingTableItem();
    this.state.routingTable.set(room, created);
    return created;
  }

  /**
   * Ensures one ingress route exists in the room routing entry.
   *
   * @param room - Room id.
   * @param ingressId - Ingress server id.
   * @returns `true` when route was newly added.
   */
  ensureRoomIngressRoute(room: string, ingressId: Guid) {
    const routing = this.getOrCreateRoomRouting(room);
    return ensureUniqueRoute(routing.ingress, ingressId);
  }

  /**
   * Ensures one egress route exists in the room routing entry.
   *
   * @param room - Room id.
   * @param egressId - Egress server id.
   * @returns `true` when route was newly added.
   */
  ensureRoomEgressRoute(room: string, egressId: Guid) {
    const routing = this.getOrCreateRoomRouting(room);
    return ensureUniqueRoute(routing.egress, egressId);
  }

  /**
   * Applies lifecycle/readiness housekeeping after routing changes.
   *
   * @param room - Room id whose routing changed.
   * @returns `void`.
   */
  onRoomUpdated(room: string) {
    const routing = this.state.routingTable.get(room);
    if (!routing) {
      this.clearRoomReadiness(room);
      this.updateRoomLifecycle(room, { type: "roomDeleted" });
      return;
    }
    this.updateRoomLifecycle(room, {
      type: "routingUpdated",
      hasIngressRoutes: routing.ingress.length > 0,
      hasEgressRoutes: routing.egress.length > 0,
    });
  }

  /**
   * Deletes room routing and all derived readiness/lifecycle state.
   *
   * @param room - Room id.
   * @returns `void`.
   */
  deleteRoom(room: string) {
    this.state.routingTable.delete(room);
    this.clearRoomReadiness(room);
    this.updateRoomLifecycle(room, { type: "roomDeleted" });
  }

  /**
   * Records last computed room egress readiness into lifecycle state.
   *
   * @param room - Room id.
   * @param ready - Whether room is currently egress ready.
   * @returns `void`.
   */
  recordRoomEgressReadiness(room: string, ready: boolean) {
    this.updateRoomLifecycle(room, {
      type: "egressReadinessEvaluated",
      ready,
    });
  }

  /**
   * Returns lifecycle state for one room when tracked.
   *
   * @param room - Room id.
   * @returns Lifecycle state or `undefined`.
   */
  getRoomLifecycleState(room: string) {
    return this.state.roomLifecycle.get(room);
  }

  /**
   * Starts a readiness broadcast cycle for a specific egress-server signature.
   *
   * Resets notified peers when signature changes.
   *
   * @param room - Room id.
   * @param egressServers - Egress server ids used to build signature.
   * @returns Mutable set of peer ids already notified for this signature.
   */
  beginRoomEgressReadyBroadcast(room: string, egressServers: Guid[]) {
    const signature = buildEgressReadySignature(egressServers);
    const previousSignature = this.state.roomEgressReadySignature.get(room);
    if (previousSignature !== signature) {
      this.state.roomEgressReadySignature.set(room, signature);
      this.state.roomEgressReadyNotifiedPeers.set(room, new Set<Guid>());
    }
    return this.state.roomEgressReadyNotifiedPeers.get(room) ?? new Set<Guid>();
  }

  /**
   * Persists the set of peers notified for the current readiness signature.
   *
   * @param room - Room id.
   * @param notifiedPeers - Peer ids already notified.
   * @returns `void`.
   */
  setRoomEgressReadyNotifiedPeers(room: string, notifiedPeers: Set<Guid>) {
    this.state.roomEgressReadyNotifiedPeers.set(room, notifiedPeers);
  }

  private clearRoomReadiness(room: string) {
    this.state.roomEgressReadySignature.delete(room);
    this.state.roomEgressReadyNotifiedPeers.delete(room);
  }

  private updateRoomLifecycle(room: string, event: RoomLifecycleEvent) {
    const currentState =
      this.state.roomLifecycle.get(room) ?? createInitialRoomLifecycleState();
    const nextState = applyRoomLifecycleEvent(currentState, event);
    if (nextState === undefined) {
      this.state.roomLifecycle.delete(room);
      return;
    }
    this.state.roomLifecycle.set(room, nextState);
  }
}
