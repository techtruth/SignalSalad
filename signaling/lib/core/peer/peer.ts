import type {
  Guid,
  JoinedPeer,
  MediaState,
  Peer as PeerRecord,
  RoomState,
} from "../../../../types/baseTypes.d.ts";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import type { SignalingDiagnosticEvent } from "../../protocol/signalingIoValidation.js";
import {
  buildDestroyRouterGroupMessage,
  buildTeardownPeerSessionMessage,
} from "../../protocol/netsocketMessageBuilders.js";
import {
  buildIdentityMessage,
  buildPeerConnectedMessage,
  buildPeerDisconnectedMessage,
  buildRoomAttachedMessage,
  buildRoomDetachedMessage,
} from "../../protocol/websocketResponseBuilders.js";
import { tracePeerLifecycle, traceRoom } from "../../observability/trace.js";
import type {
  MediaServerPipe,
  RoutingTableItems,
} from "../../protocol/signalingTypes.js";
import {
  applyPeerEvent,
  buildPeerFailure,
  assertValidPeerInvariant,
  canApplyPeerEvent,
  describeJoinRequestBlockReason,
  isPeerJoined,
  PeerStateError,
  requirePeerJoined,
  requirePeerLobby,
} from "./peerStateMachine.js";
import uuid from "uuid4";

/**
 * Guards required values at module boundaries and narrows away nullable types.
 *
 * Throws immediately with a caller-provided message so higher layers can emit
 * actionable diagnostics with stable error wording.
 */
const requireValue = <T>(value: T | undefined | null, message: string): T => {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
};

/**
 * Enforces that room-scoped peer operations include a non-empty room id.
 *
 * The structured `PeerStateError` payload keeps reject responses consistent
 * across room transition handlers.
 */
const assertRoomNameProvided = (params: {
  peer: PeerRecord;
  room: string;
  context: string;
  reason: string;
  expectedRoomState?: RoomState | RoomState[];
  expectedMediaState?: MediaState | MediaState[];
  targetRoomState?: RoomState;
}) => {
  if (params.room) {
    return;
  }
  throw new PeerStateError(
    buildPeerFailure({
      context: params.context,
      peer: params.peer,
      expectedRoomState: params.expectedRoomState,
      expectedMediaState: params.expectedMediaState,
      targetRoomState: params.targetRoomState,
      reason: params.reason,
    }),
  );
};

/**
 * Enforces that a peer currently belongs to the expected room.
 *
 * Used by room-specific command handlers to prevent stale or cross-room
 * commands from mutating unrelated room state.
 */
const assertPeerInRoom = (params: {
  peer: PeerRecord;
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

type EgressJoinTarget = {
  peerId: Guid;
  transportSignal: Guid;
};

/**
 * Returns joined peers that must receive an egress join request when a new
 * egress route is introduced for the room.
 */
const findPeersRequiringEgressJoin = (params: {
  roomPeerIds: Guid[];
  attachedPeerId: Guid;
  selectedEgress: Guid;
  resolvePeer: (peerId: Guid) => PeerRecord;
}): EgressJoinTarget[] => {
  const targets = new Array<EgressJoinTarget>();
  for (const roomPeerId of params.roomPeerIds) {
    if (roomPeerId === params.attachedPeerId) {
      continue;
    }
    const peerData = params.resolvePeer(roomPeerId);
    if (!isPeerJoined(peerData) || peerData.egress === params.selectedEgress) {
      continue;
    }
    targets.push({
      peerId: roomPeerId,
      transportSignal: peerData.transportSignal,
    });
  }
  return targets;
};

/** Builds `roomAttached.roomPeers` without echoing the joining peer itself. */
const buildRoomAttachedPeersList = (
  attachedPeer: JoinedPeer,
  roomPeerIds: Guid[],
) => roomPeerIds.filter((peerId) => peerId !== attachedPeer.id);

/**
 * Builds an isolated routing snapshot for transactional room joins.
 *
 * `getRoomRouting()` returns a live map value by reference. Join logic mutates
 * routing before all outbound join dispatches succeed, so the flow stages those
 * edits in this snapshot and commits only after success.
 */
const snapshotRoomRouting = (
  routing: RoutingTableItems | undefined,
): RoutingTableItems => ({
  ingress: [...(routing?.ingress ?? [])],
  egress: [...(routing?.egress ?? [])],
});

/** Appends a route once and reports whether a new route was added. */
const ensureUniqueRoute = (routes: Guid[], serverId: Guid) => {
  if (routes.includes(serverId)) {
    return false;
  }
  routes.push(serverId);
  return true;
};

/** Session index operations required by peer lifecycle orchestration. */
export type PeerSessionsPort = {
  getPeer(peerId: Guid): PeerRecord | undefined;
  getRoomPeerIds(room: string): Guid[];
  getPeerIdByOrigin(originId: Guid): Guid | undefined;
  clearOrigin(originId: Guid): void;
  savePeer(peer: PeerRecord): void;
  getPeerCount(): number;
  setOrigin(originId: Guid, peerId: Guid): void;
  markPeerClosing(peerId: Guid): void;
  clearPeerRooms(peerId: Guid): string[];
  hasAnyTransports(peerId: Guid): boolean;
  removePeer(peerId: Guid): void;
  removePeerFromRoom(peerId: Guid, room: string): void;
  addPeerToRoom(peerId: Guid, room: string): void;
  getRoomPeerCount(room: string): number;
};

/** Producer lookup operations used by room detach and cleanup flows. */
export type PeerProducerPort = {
  getIngressServer(producerId: Guid): Guid | undefined;
  clearRoom(roomName: string): void;
};

/** Room routing/join orchestration surface consumed by peer lifecycle logic. */
export type PeerRoomPort = {
  getRoomRouting(room: string): RoutingTableItems | undefined;
  saveRoomRouting(room: string, routing: RoutingTableItems): void;
  destroyRoomRouting(room: string): void;
  onRoomUpdated(room: string): void;
  requestJoin(
    room: string,
    wsTransportId: Guid,
    serverType: "ingress" | "egress",
    serverId: Guid,
  ): void;
};

/** Server-selection surface used when assigning ingress/egress for room joins. */
export type PeerServerRegistryPort = {
  selectRegionalServers: (region: string) => {
    selectedIngress: Guid | undefined;
    selectedEgress: Guid | undefined;
  };
};

/** Transport cleanup helpers consumed by leave/close peer flows. */
export type PeerWebRTCTransportPort = {
  cleanupPeerTransports: (
    peer: PeerRecord,
    mode: "leaving" | "closing",
  ) => {
    ingressTransportIds: Guid[];
    egressTransportIds: Guid[];
  };
};

/** Media-session cleanup hooks consumed by peer teardown logic. */
export type PeerMediaSessionPort = {
  releasePeerProducersForCleanup: (peerId: Guid) => Guid[];
};

/** Status reporter hooks used during room cleanup side effects. */
export type PeerStatusReporterPort = {
  clearRoomRouterDumps: (roomName: string) => void;
};

/** Pipe-registry operations used to strip stale room relay pipes. */
export type PeerPipeRegistryPort = {
  listPipes(): readonly MediaServerPipe[];
  replacePipes(nextPipes: MediaServerPipe[]): void;
};

/**
 * Dependency surface required by peer lifecycle orchestration.
 *
 * Peer logic is intentionally agnostic to concrete transport/session
 * implementations and depends on this narrowed context contract.
 */
export type PeerContext = {
  sessions: PeerSessionsPort;
  producers: PeerProducerPort;
  room: PeerRoomPort;
  pipeRegistry: PeerPipeRegistryPort;
  signalingMessenger: SignalingMessenger;
  serverRegistry: PeerServerRegistryPort;
  peerWebRTCTransport: PeerWebRTCTransportPort;
  peerMediaSession: PeerMediaSessionPort;
  statusReporter: PeerStatusReporterPort;
  recordDiagnostic: (event: SignalingDiagnosticEvent) => void;
};

/**
 * Owns peer session lifecycle transitions.
 *
 * Responsibilities:
 * - identity creation/rebinding
 * - room join/leave orchestration
 * - disconnect cleanup and peer notifications
 */
export class Peer {
  private context: PeerContext;

  constructor(context: PeerContext) {
    this.context = context;
  }

  /**
   * Loads a peer record and enforces state invariants before use.
   */
  private requirePeer(peerId: Guid, context: string): PeerRecord {
    const peer = requireValue(
      this.context.sessions.getPeer(peerId),
      `Missing peer ${peerId} on ${context}`,
    );
    assertValidPeerInvariant(peer, `peer.${context}`);
    return peer;
  }

  /**
   * Broadcasts a `peerConnected` event to room peers excluding the new member.
   */
  private announcePeerConnected(room: string, peerId: Guid) {
    const message = buildPeerConnectedMessage(peerId, room);
    for (const roomPeerId of this.context.sessions.getRoomPeerIds(room)) {
      if (roomPeerId === peerId) {
        continue;
      }
      const peerData = this.requirePeer(roomPeerId, "announcePeerConnected");
      this.context.signalingMessenger.sendWebsocketMessage(
        peerData.transportSignal,
        "peerConnected",
        message,
      );
    }
  }

  /**
   * Broadcasts a `peerDisconnected` event to all peers currently indexed in the
   * room.
   */
  private announcePeerDisconnected(room: string, peerId: Guid) {
    const message = buildPeerDisconnectedMessage(peerId, room);
    for (const roomPeerId of this.context.sessions.getRoomPeerIds(room)) {
      const peerData = this.requirePeer(roomPeerId, "announcePeerDisconnected");
      this.context.signalingMessenger.sendWebsocketMessage(
        peerData.transportSignal,
        "peerDisconnected",
        message,
      );
    }
  }

  /**
   * Selects ingress/egress candidates for a peer region and upgrades optional
   * selector outputs into required values for downstream join flow.
   */
  private selectRegionalServers(peer: PeerRecord) {
    const {
      selectedIngress: ingressCandidate,
      selectedEgress: egressCandidate,
    } = this.context.serverRegistry.selectRegionalServers(peer.region);
    const selectedIngress = requireValue(
      ingressCandidate,
      "no ingress server available for requested region",
    );
    const selectedEgress = requireValue(
      egressCandidate,
      "no egress server available for requested region",
    );
    return { selectedIngress, selectedEgress };
  }

  /**
   * Computes a joined-state peer record without committing session indexes.
   *
   * Join uses this staged value so netsocket dispatch can fail safely before
   * the final peer/session commit.
   */
  private attachPeerToRoom(params: {
    lobbyPeer: PeerRecord;
    room: string;
    selectedIngress: Guid;
    selectedEgress: Guid;
  }) {
    const { lobbyPeer, room, selectedIngress, selectedEgress } = params;
    const { updatedPeer } = applyPeerEvent({
      peer: lobbyPeer,
      event: {
        type: "joinRequested",
        room,
        ingress: selectedIngress,
        egress: selectedEgress,
      },
      context: "peer.joinRoom",
    });
    const attachedPeer = requirePeerJoined({
      peer: updatedPeer,
      context: "peer.joinRoom:postJoin",
    });
    return attachedPeer;
  }

  /**
   * Updates staged routing and dispatches egress join fanout when introducing
   * a newly discovered egress route.
   *
   * `joiningRoom` is expected to be caller-owned staged state.
   */
  private dispatchRoomRoutingJoinRequests(params: {
    room: string;
    joiningRoom: RoutingTableItems;
    attachedPeer: JoinedPeer;
    selectedEgress: Guid;
  }) {
    const { room, joiningRoom, attachedPeer, selectedEgress } = params;
    ensureUniqueRoute(joiningRoom.ingress, attachedPeer.ingress);
    const addedEgressRoute = ensureUniqueRoute(
      joiningRoom.egress,
      attachedPeer.egress,
    );
    if (addedEgressRoute) {
      const peersNeedingEgressJoin = findPeersRequiringEgressJoin({
        roomPeerIds: this.context.sessions.getRoomPeerIds(room),
        attachedPeerId: attachedPeer.id,
        selectedEgress,
        resolvePeer: (peerId: Guid) =>
          this.requirePeer(peerId, `joinRoom:existingPeer:${room}`),
      });
      for (const peerData of peersNeedingEgressJoin) {
        this.context.room.requestJoin(
          room,
          peerData.transportSignal,
          "egress",
          attachedPeer.egress,
        );
      }

      this.context.room.requestJoin(
        room,
        attachedPeer.transportSignal,
        "egress",
        attachedPeer.egress,
      );
    }
  }

  /**
   * Emits post-commit websocket notifications for a successful room join.
   */
  private notifyJoin(
    attachedPeer: JoinedPeer,
    room: string,
    joiningRoom: RoutingTableItems,
  ) {
    const attachedMessage = buildRoomAttachedMessage({
      peerId: attachedPeer.id,
      room,
      egressServers: joiningRoom.egress,
      roomPeers: buildRoomAttachedPeersList(
        attachedPeer,
        this.context.sessions.getRoomPeerIds(room),
      ),
    });
    this.context.signalingMessenger.sendWebsocketMessage(
      attachedPeer.transportSignal,
      "roomAttached",
      attachedMessage,
    );
    this.announcePeerConnected(room, attachedPeer.id);
  }

  /**
   * Creates or rebinds a peer identity to the websocket origin and sends `identity`.
   */
  createPeer(wsid: Guid, region: string): void {
    const existingPeerId = this.context.sessions.getPeerIdByOrigin(wsid);
    if (existingPeerId && !this.context.sessions.getPeer(existingPeerId)) {
      this.context.sessions.clearOrigin(wsid);
    }
    let peer = existingPeerId
      ? this.context.sessions.getPeer(existingPeerId)
      : undefined;

    if (peer) {
      assertValidPeerInvariant(peer, "peer.createPeer:existing");
      const updatedPeer: PeerRecord = {
        ...peer,
        region,
      };
      assertValidPeerInvariant(updatedPeer, "peer.createPeer:existing");
      this.context.sessions.savePeer(updatedPeer);
      peer = updatedPeer;
      tracePeerLifecycle("reconnected", {
        peerId: peer.id,
        peerCount: this.context.sessions.getPeerCount(),
      });
    } else {
      peer = {
        id: uuid() as Guid,
        transportSignal: wsid,
        transportIngress: {},
        transportEgress: {},
        region: region,
        isLobby: true,
        isParticipant: false,
        isSpectator: false,
        mediaProducers: {},
        roomState: "lobby",
        mediaState: "none",
        room: undefined,
        ingress: undefined,
        egress: undefined,
        deviceRTPCapabilities: undefined,
      };
      assertValidPeerInvariant(peer, "peer.createPeer:new");

      this.context.sessions.savePeer(peer);
      tracePeerLifecycle("identity_assigned", {
        peerId: peer.id,
        peerCount: this.context.sessions.getPeerCount(),
      });
    }

    this.context.sessions.setOrigin(wsid, peer.id);

    const message = buildIdentityMessage(peer.id, wsid, region);
    this.context.signalingMessenger.sendWebsocketMessage(
      wsid,
      "identity",
      message,
    );
  }

  /**
   * Performs disconnect cleanup for a peer and notifies room peers when applicable.
   */
  deletePeer(peerId: Guid) {
    const deletedPeer = this.requirePeer(peerId, "deletePeer");
    tracePeerLifecycle("disconnected", {
      peerId: deletedPeer.id,
      peerCount: this.context.sessions.getPeerCount(),
    });
    const roomName = deletedPeer.room;
    this.context.sessions.markPeerClosing(peerId);

    this.cleanupPeerSession(deletedPeer, "closing");
    const postCleanupPeer = this.requirePeer(peerId, "deletePeer:postCleanup");

    if (
      isPeerJoined(postCleanupPeer) &&
      canApplyPeerEvent(postCleanupPeer, "peerDisconnected")
    ) {
      const { updatedPeer } = applyPeerEvent({
        peer: postCleanupPeer,
        event: { type: "peerDisconnected" },
        context: "peer.deletePeer",
      });
      this.context.sessions.savePeer(updatedPeer);
    }

    const clearedRooms = this.context.sessions.clearPeerRooms(peerId);
    for (const clearedRoom of clearedRooms) {
      traceRoom("clear", clearedRoom, peerId);
    }

    if (roomName) {
      this.announcePeerDisconnected(roomName, peerId);
      this.cleanupRoomIfEmpty(roomName);
      this.context.room.onRoomUpdated(roomName);
    }

    if (!this.context.sessions.hasAnyTransports(peerId)) {
      this.context.sessions.removePeer(peerId);
    }
  }

  /**
   * Transitions a lobby peer into joined state and issues room attach/connect
   * side effects.
   *
   * Join execution is transactional:
   * - stage peer and routing mutations in memory
   * - dispatch required ingress/egress join requests
   * - commit staged state only if all dispatches succeed
   * - rollback peer state when dispatch fails
   */
  joinRoom(peerId: Guid, room: string) {
    const joiningPeer = this.requirePeer(peerId, "joinRoom");
    const lobbyPeer = requirePeerLobby({
      peer: joiningPeer,
      context: "peer.joinRoom",
      reason: describeJoinRequestBlockReason(joiningPeer),
    });
    assertRoomNameProvided({
      peer: lobbyPeer,
      room,
      context: "peer.joinRoom",
      expectedRoomState: "lobby",
      targetRoomState: "joined",
      reason: "join request requires a non-empty room name",
    });

    const { selectedIngress, selectedEgress } =
      this.selectRegionalServers(lobbyPeer);
    const attachedPeer = this.attachPeerToRoom({
      lobbyPeer,
      room,
      selectedIngress,
      selectedEgress,
    });
    const joiningRoom = snapshotRoomRouting(
      this.context.room.getRoomRouting(room),
    );

    try {
      for (const egressId of joiningRoom.egress) {
        this.context.room.requestJoin(
          room,
          lobbyPeer.transportSignal,
          "egress",
          egressId,
        );
      }

      this.context.room.requestJoin(
        room,
        lobbyPeer.transportSignal,
        "ingress",
        selectedIngress,
      );

      this.dispatchRoomRoutingJoinRequests({
        room,
        joiningRoom,
        attachedPeer,
        selectedEgress,
      });
    } catch (error) {
      this.context.sessions.removePeerFromRoom(peerId, room);
      this.context.sessions.savePeer(lobbyPeer);
      throw error;
    }

    this.context.sessions.savePeer(attachedPeer);
    this.context.sessions.addPeerToRoom(peerId, room);
    traceRoom("join", room, peerId);
    this.context.room.saveRoomRouting(room, joiningRoom);
    this.notifyJoin(attachedPeer, room, joiningRoom);
  }

  /**
   * Transitions a joined peer back to lobby state and tears down room-side resources.
   */
  async leaveRoom(leavingPeerId: Guid, room: string) {
    const leavingPeerData = this.requirePeer(leavingPeerId, "leaveRoom");
    const joinedPeer = requirePeerJoined({
      peer: leavingPeerData,
      context: "peer.leaveRoom",
      reason: "peer is not joined to a room",
    });
    assertRoomNameProvided({
      peer: joinedPeer,
      room,
      context: "peer.leaveRoom",
      expectedRoomState: "joined",
      reason: "leave request requires a non-empty room name",
    });
    assertPeerInRoom({
      peer: leavingPeerData,
      expectedRoom: room,
      context: "peer.leaveRoom",
      expectedRoomState: "joined",
      reason: "peer attempted to leave a room it is not currently in",
    });
    this.cleanupPeerSession(joinedPeer, "leaving");
    const postCleanupPeer = this.requirePeer(
      leavingPeerId,
      "leaveRoom:postCleanup",
    );
    this.context.sessions.removePeerFromRoom(leavingPeerId, room);
    traceRoom("leave", room, leavingPeerId);

    this.announcePeerDisconnected(room, leavingPeerId);

    const { updatedPeer } = applyPeerEvent({
      peer: postCleanupPeer,
      event: { type: "leaveRequested" },
      context: "peer.leaveRoom",
    });
    const lobbyPeer = requirePeerLobby({
      peer: updatedPeer,
      context: "peer.leaveRoom:postLeave",
    });
    this.context.sessions.savePeer(lobbyPeer);

    const detachedMessage = buildRoomDetachedMessage(leavingPeerId, room);
    this.context.signalingMessenger.sendWebsocketMessage(
      joinedPeer.transportSignal,
      "roomDetached",
      detachedMessage,
    );

    this.cleanupRoomIfEmpty(room);
    this.context.room.onRoomUpdated(room);
    tracePeerLifecycle("left_room", {
      peerId: leavingPeerId,
      room,
    });
  }

  /**
   * Derives ingress/egress teardown targets from peer transports, assigned
   * routes, producer ownership, and live pipe graph membership.
   */
  private resolvePeerCleanupTargets(params: {
    peer: PeerRecord;
    producerIds: Guid[];
  }) {
    const ingressTargets = new Set<Guid>();
    const egressTargets = new Set<Guid>();
    const { peer, producerIds } = params;

    for (const serverId of Object.keys(peer.transportIngress)) {
      ingressTargets.add(serverId as Guid);
    }
    for (const serverId of Object.keys(peer.transportEgress)) {
      egressTargets.add(serverId as Guid);
    }

    if (peer.ingress) {
      ingressTargets.add(peer.ingress);
    }
    if (peer.egress) {
      egressTargets.add(peer.egress);
    }

    for (const producerId of producerIds) {
      const ingressServerId =
        this.context.producers.getIngressServer(producerId);
      if (ingressServerId) {
        ingressTargets.add(ingressServerId);
      }
      for (const pipe of this.context.pipeRegistry.listPipes()) {
        if (pipe.producerIds.includes(producerId)) {
          egressTargets.add(pipe.egress);
        }
      }
    }

    return { ingressTargets, egressTargets };
  }

  /**
   * Dispatches `teardownPeerSession` to all impacted media servers and records
   * per-target diagnostics on partial failures.
   */
  private dispatchPeerMediaTeardown(params: {
    peer: PeerRecord;
    mode: "leaving" | "closing";
    producerIds: Guid[];
    transportIds: Guid[];
  }) {
    const { peer, mode, producerIds, transportIds } = params;
    const { ingressTargets, egressTargets } = this.resolvePeerCleanupTargets({
      peer,
      producerIds,
    });
    if (!ingressTargets.size && !egressTargets.size) {
      return;
    }
    const operationId = uuid() as Guid;
    const message = buildTeardownPeerSessionMessage({
      originId: peer.transportSignal,
      peerId: peer.id,
      operationId,
      mode,
      transportIds,
      producerIds,
    });

    const sendToTargets = (
      targets: Set<Guid>,
      channel: "ingress" | "egress",
    ) => {
      for (const serverId of targets) {
        try {
          this.context.signalingMessenger.sendNetsocketMessage(
            serverId,
            channel,
            "teardownPeerSession",
            message,
          );
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.context.recordDiagnostic({
            severity: "warn",
            category: "mediaServerLifecycle",
            message: "peer teardown dispatch failed",
            details: `peerId=${peer.id}, operationId=${operationId}, serverId=${serverId}, mode=${channel}, error=${errorMessage}`,
            context: {
              peerId: peer.id,
              operationId,
              mode: channel,
              serverId,
            },
          });
          tracePeerLifecycle("teardown_dispatch_failed", {
            peerId: peer.id,
            operationId,
            mode: channel,
            serverId,
            error: errorMessage,
          });
        }
      }
    };

    sendToTargets(ingressTargets, "ingress");
    sendToTargets(egressTargets, "egress");
  }

  /**
   * Clears producer/transport state for a peer and notifies media servers to
   * destroy associated runtime resources.
   */
  private cleanupPeerSession(peer: PeerRecord, mode: "leaving" | "closing") {
    const producerIds =
      this.context.peerMediaSession.releasePeerProducersForCleanup(peer.id);
    const transportState =
      this.context.peerWebRTCTransport.cleanupPeerTransports(peer, mode);
    this.dispatchPeerMediaTeardown({
      peer,
      mode,
      producerIds,
      transportIds: [
        ...transportState.ingressTransportIds,
        ...transportState.egressTransportIds,
      ],
    });
  }

  /**
   * Best-effort `destroyRouterGroup` fanout for empty-room cleanup.
   */
  private destroyRouterGroupOnServers(params: {
    roomName: string;
    mode: "ingress" | "egress";
    serverIds: Guid[];
    message: ReturnType<typeof buildDestroyRouterGroupMessage>;
  }) {
    const { roomName, mode, serverIds, message } = params;
    for (const serverId of serverIds) {
      try {
        this.context.signalingMessenger.sendNetsocketMessage(
          serverId,
          mode,
          "destroyRouterGroup",
          message,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.context.recordDiagnostic({
          severity: "warn",
          category: "mediaServerLifecycle",
          message: `room cleanup destroyRouterGroup send failed (${mode})`,
          details: `room=${roomName}, serverId=${serverId}, error=${errorMessage}`,
          context: {
            room: roomName,
            mode,
            serverId,
          },
        });
        tracePeerLifecycle("destroy_router_group_failed", {
          room: roomName,
          mode,
          serverId,
          error: errorMessage,
        });
      }
    }
  }

  /**
   * Performs final room cleanup when no joined peers remain.
   *
   * This removes media routing artifacts, routing index state, producer index
   * data, and router dump cache entries tied to the room.
   */
  private cleanupRoomIfEmpty(roomName: string) {
    const numberOfPeers = this.context.sessions.getRoomPeerCount(roomName);
    if (numberOfPeers !== 0) {
      return;
    }
    const routingTable = this.context.room.getRoomRouting(roomName);
    const message = buildDestroyRouterGroupMessage(roomName);

    if (routingTable) {
      this.destroyRouterGroupOnServers({
        roomName,
        mode: "ingress",
        serverIds: routingTable.ingress,
        message,
      });
      this.destroyRouterGroupOnServers({
        roomName,
        mode: "egress",
        serverIds: routingTable.egress,
        message,
      });
    }
    const remainingPipes = this.context.pipeRegistry
      .listPipes()
      .filter((pipe) => pipe.room !== roomName);
    this.context.pipeRegistry.replacePipes(remainingPipes);
    this.context.room.destroyRoomRouting(roomName);
    this.context.producers.clearRoom(roomName);
    this.context.statusReporter.clearRoomRouterDumps(roomName);
  }
}
