import type { Guid, Peer } from "../../../../types/baseTypes.d.ts";
import type {
  MediaInboundMessageMap,
  MediaInboundPayload,
  NodeId,
  NsMessageMap,
  SignalingDiagnosticEvent,
} from "../../protocol/signalingIoValidation.js";
import { buildDestroyRouterGroupMessage } from "../../protocol/netsocketMessageBuilders.js";
import { traceMediaServerLifecycle } from "../../observability/trace.js";
import type {
  MediaServerPipe,
  RoutingTableItems,
} from "../../protocol/signalingTypes.js";
import type { MediaServerMode } from "./types.js";
import type {
  MediaServerConnectionRegistryPort,
  MediaServerRegistration,
} from "./serverConnectionRegistry.js";

export type { MediaServerRegistration } from "./serverConnectionRegistry.js";

/** Recently observed media-server offline/ejection snapshot used by status reporting. */
export type MediaServerOfflineEvent = {
  mode: MediaServerMode;
  region?: string;
  graceful: boolean;
  reason?: string;
  detail?: string;
  trigger: string;
  at: string;
};

const SERVER_OFFLINE_EVENT_TTL_MS = 60_000;

/** Diagnostic payload forwarded to shared signaling diagnostics (timestamp is injected by caller). */
export type DiagnosticEvent = SignalingDiagnosticEvent;

/** Peer lifecycle operations used during media-server ejection cleanup. */
export type MediaServerPeerPort = {
  deletePeer(peerId: Guid): void;
};

/** Room routing operations needed to prune rooms tied to an ejected server. */
export type MediaServerRoomRoutingPort = {
  getRoutingTable(): Map<string, RoutingTableItems>;
  deleteRoom(roomName: string): void;
};

/** Producer registry operations used during room teardown. */
export type MediaServerProducerPort = {
  clearRoom(roomName: string): void;
};

/** Media-server region/load registry operations used by lifecycle handlers. */
export type MediaServerRegistryPort = {
  resolveServerToRegion(serverId: Guid): string | undefined;
  pruneServerRegionAndLoad(mode: MediaServerMode, serverId: Guid): void;
  setServerLoadSnapshot(
    mode: MediaServerMode,
    region: string,
    serverId: Guid,
    load: number,
    loadPerCpu: number[] | undefined,
  ): void;
  registerServer(mode: MediaServerMode, region: string, serverId: Guid): void;
};

/** Pipe-registry access used to purge relay pipes for removed servers. */
export type MediaServerPipeRegistryPort = {
  listPipes(): readonly MediaServerPipe[];
  replacePipes(nextPipes: MediaServerPipe[]): void;
};

/** Netsocket transport surface used to dispatch media-server commands. */
export type MediaServerTransportPort = {
  send<T extends keyof NsMessageMap>(
    destinationNode: Guid,
    channel: MediaServerMode,
    type: T,
    message: NsMessageMap[T],
  ): void;
};

/** Status reporter hooks used to clear stale router dump snapshots. */
export type MediaServerStatusReporterPort = {
  clearRoomRouterDumps(roomName: string): void;
  clearServerRouterDumps(serverId: Guid): void;
};

/** Constructor dependencies for `MediaServer` lifecycle orchestration. */
export type MediaServerContext<ConnectionRef extends object = object> = {
  peers: Map<Guid, Peer>;
  peer: MediaServerPeerPort;
  roomRouting: MediaServerRoomRoutingPort;
  producers: MediaServerProducerPort;
  transport: MediaServerTransportPort;
  connectionRegistry: MediaServerConnectionRegistryPort<ConnectionRef>;
  pipeRegistry: MediaServerPipeRegistryPort;
  serverOfflineEvents: Record<string, MediaServerOfflineEvent>;
  serverRegistry: MediaServerRegistryPort;
  statusReporter: MediaServerStatusReporterPort;
  recordDiagnostic: (event: DiagnosticEvent) => void;
};

/**
 * Manages media server registration, identity validation, and ejection cleanup.
 */
export class MediaServer<ConnectionRef extends object = object> {
  private readonly context: MediaServerContext<ConnectionRef>;

  /**
   * Creates media-server lifecycle orchestrator bound to signaling runtime ports.
   *
   * @param context - Media-server lifecycle dependencies.
   */
  constructor(context: MediaServerContext<ConnectionRef>) {
    this.context = context;
  }

  /**
   * Returns currently registered connection for one server/mode pair.
   *
   * @param serverId - Media server id.
   * @param mode - Media server mode.
   * @returns Registered connection when present.
   */
  private getRegisteredServerConnection(
    serverId: Guid,
    mode: MediaServerMode,
  ): ConnectionRef | undefined {
    return this.context.connectionRegistry.getServerConnection(serverId, mode);
  }

  /**
   * Drops stale offline events kept only for recent status visibility.
   *
   * @param nowMs - Optional clock override used by deterministic tests.
   * @returns `void`.
   */
  pruneExpiredServerOfflineEvents(nowMs = Date.now()) {
    const cutoffMs = nowMs - SERVER_OFFLINE_EVENT_TTL_MS;
    for (const [serverId, event] of Object.entries(
      this.context.serverOfflineEvents,
    )) {
      const eventMs = Date.parse(event.at);
      if (!Number.isFinite(eventMs) || eventMs <= cutoffMs) {
        delete this.context.serverOfflineEvents[serverId];
      }
    }
  }

  /**
   * Records an offline/ejection snapshot for one server.
   *
   * @param params - Offline event metadata.
   * @returns Resolved region used for offline snapshot.
   */
  private recordServerOffline(params: {
    serverId: Guid;
    mode: MediaServerMode;
    graceful: boolean;
    trigger: string;
    region?: string;
    reason?: string;
    detail?: string;
  }): string | undefined {
    const resolvedRegion =
      params.region ??
      this.context.serverRegistry.resolveServerToRegion(params.serverId);
    this.context.serverOfflineEvents[params.serverId] = {
      mode: params.mode,
      region: resolvedRegion,
      graceful: params.graceful,
      reason: params.reason,
      detail: params.detail,
      trigger: params.trigger,
      at: new Date().toISOString(),
    };
    return resolvedRegion;
  }

  /**
   * Removes peers currently bound to the ejected media server.
   *
   * @param serverId - Ejected server id.
   * @param mode - Ejected server mode.
   * @returns `void`.
   */
  private detachImpactedPeers(serverId: Guid, mode: MediaServerMode) {
    for (const [peerId, peer] of this.context.peers.entries()) {
      if (peer.ingress === serverId || peer.egress === serverId) {
        this.context.recordDiagnostic({
          severity: "warn",
          category: "mediaServerLifecycle",
          message: "peer removed due media server ejection",
          details: `peerId=${peerId}, mode=${mode}, serverId=${serverId}`,
          context: {
            peerId,
            mode,
            serverId,
          },
        });
        traceMediaServerLifecycle("peer_removed", {
          peerId,
          mode,
          serverId,
          reason: "media_server_ejection",
        });
        this.context.peer.deletePeer(peerId);
      }
    }
  }

  /**
   * Broadcasts destroyRouterGroup to remaining servers in the room path.
   *
   * @param params - Destroy-router dispatch context.
   * @returns `void`.
   */
  private destroyRouterGroupOnRemainingServers(params: {
    roomName: string;
    mode: MediaServerMode;
    serverIds: Guid[];
    excludedServerId: Guid;
    destroyMessage: NsMessageMap["destroyRouterGroup"];
  }) {
    const { roomName, mode, serverIds, excludedServerId, destroyMessage } =
      params;
    for (const serverId of serverIds) {
      if (
        serverId === excludedServerId ||
        !this.context.connectionRegistry.getServerConnection(serverId, mode)
      ) {
        continue;
      }
      try {
        this.context.transport.send(
          serverId,
          mode,
          "destroyRouterGroup",
          destroyMessage,
        );
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.context.recordDiagnostic({
          severity: "warn",
          category: "mediaServerLifecycle",
          message: `server ejection destroyRouterGroup send failed (${mode})`,
          details: `room=${roomName}, serverId=${serverId}, ejectedServerId=${excludedServerId}, error=${errorMessage}`,
          context: {
            room: roomName,
            mode,
            serverId,
            ejectedServerId: excludedServerId,
          },
        });
        traceMediaServerLifecycle("destroy_router_group_failed", {
          room: roomName,
          mode,
          serverId,
          ejectedServerId: excludedServerId,
          error: errorMessage,
        });
      }
    }
  }

  /**
   * Tears down all room routing and producer state touching the ejected server.
   *
   * @param serverId - Ejected media server id.
   * @returns `void`.
   */
  private teardownServerRooms(serverId: Guid) {
    const routingTable = this.context.roomRouting.getRoutingTable();
    for (const [roomName, room] of [...routingTable.entries()]) {
      if (!room.ingress.includes(serverId) && !room.egress.includes(serverId)) {
        continue;
      }
      const destroyMessage = buildDestroyRouterGroupMessage(roomName);
      this.destroyRouterGroupOnRemainingServers({
        roomName,
        mode: "ingress",
        serverIds: room.ingress,
        excludedServerId: serverId,
        destroyMessage,
      });
      this.destroyRouterGroupOnRemainingServers({
        roomName,
        mode: "egress",
        serverIds: room.egress,
        excludedServerId: serverId,
        destroyMessage,
      });

      this.context.roomRouting.deleteRoom(roomName);
      this.context.producers.clearRoom(roomName);
      this.context.statusReporter.clearRoomRouterDumps(roomName);
    }
  }

  /**
   * Prunes connection, status, and region/load indexes for one server.
   *
   * @param serverId - Ejected media server id.
   * @param mode - Ejected server mode.
   * @returns `void`.
   */
  private pruneServerIndexes(serverId: Guid, mode: MediaServerMode) {
    this.context.connectionRegistry.removeServerConnection(serverId, mode);
    this.context.statusReporter.clearServerRouterDumps(serverId);
    this.context.serverRegistry.pruneServerRegionAndLoad(mode, serverId);
  }

  /**
   * Removes all relay-pipe entries referencing one media server.
   *
   * @param serverId - Ejected media server id.
   * @returns `void`.
   */
  private pruneServerPipes(serverId: Guid) {
    const remainingPipes = this.context.pipeRegistry
      .listPipes()
      .filter((pipe) => pipe.ingress !== serverId && pipe.egress !== serverId);
    this.context.pipeRegistry.replacePipes(remainingPipes);
  }

  /**
   * Executes full media-server ejection lifecycle.
   *
   * Order:
   * 1) record offline snapshot + diagnostics/traces,
   * 2) remove impacted peers,
   * 3) teardown server-bound room state,
   * 4) prune server/pipe indexes.
   *
   * @param params - Ejection metadata.
   * @returns `void`.
   * @throws {Error} When attempting to eject reserved `signaling` id.
   */
  private ejectMediaServer(params: {
    serverId: Guid;
    mode: MediaServerMode;
    graceful: boolean;
    trigger: string;
    region?: string;
    reason?: string;
    detail?: string;
  }) {
    if (params.serverId === "signaling") {
      throw new Error(
        `${params.trigger} blocked: invalid media server id '${params.serverId}'`,
      );
    }
    const resolvedRegion = this.recordServerOffline(params);
    if (!params.graceful) {
      this.context.recordDiagnostic({
        severity: "warn",
        category: "mediaServerLifecycle",
        message: "media server ejected ungracefully",
        details: `serverId=${params.serverId}, mode=${params.mode}, trigger=${params.trigger}, reason=${params.reason ?? "unknown"}, detail=${params.detail ?? "none"}`,
        context: {
          serverId: params.serverId,
          mode: params.mode,
          trigger: params.trigger,
          reason: params.reason ?? "unknown",
          detail: params.detail ?? "none",
        },
      });
    }
    traceMediaServerLifecycle("eject_started", {
      serverId: params.serverId,
      mode: params.mode,
      region: resolvedRegion,
      graceful: params.graceful,
      reason: params.reason,
      detail: params.detail,
      trigger: params.trigger,
    });

    this.detachImpactedPeers(params.serverId, params.mode);
    this.teardownServerRooms(params.serverId);
    this.pruneServerIndexes(params.serverId, params.mode);
    this.pruneServerPipes(params.serverId);

    traceMediaServerLifecycle("eject_completed", {
      serverId: params.serverId,
      mode: params.mode,
      region: resolvedRegion,
      graceful: params.graceful,
      trigger: params.trigger,
    });
  }

  /**
   * Handles media netsocket close and ejects the registered server identity if present.
   *
   * @param connection - Closed netsocket connection reference.
   * @returns `void`.
   */
  handleNetsocketClose(connection: ConnectionRef) {
    const registeredIdentity =
      this.context.connectionRegistry.getIdentity(connection);
    if (registeredIdentity) {
      this.context.recordDiagnostic({
        severity: "warn",
        category: "mediaServerLifecycle",
        message: "media server netsocket closed before unregister",
        details: `serverId=${registeredIdentity.serverId}, mode=${registeredIdentity.mode}`,
        context: {
          serverId: registeredIdentity.serverId,
          mode: registeredIdentity.mode,
        },
      });
      this.ejectMediaServer({
        serverId: registeredIdentity.serverId,
        mode: registeredIdentity.mode,
        graceful: false,
        reason: "socket_closed",
        detail: "netsocket connection closed before unregister",
        trigger: "handleNetsocketClose",
      });
      return;
    }
    this.context.connectionRegistry.deleteIdentity(connection);
  }

  /**
   * Validates registration identity fields in `registerMediaServer` payload.
   *
   * @param params - Registration identity fields and error scope.
   * @returns Validated server registration id.
   * @throws {Error} When registration id is missing, reserved, or mismatched.
   */
  private requireRegisterMediaServerIdentity(params: {
    node: NodeId;
    registrationId: Guid | undefined;
    errorScope: "incomingNetsocketCommand" | "registerMediaServer";
  }): Guid {
    const { node, registrationId, errorScope } = params;
    if (!registrationId) {
      if (errorScope === "incomingNetsocketCommand") {
        throw new Error(
          "incomingNetsocketCommand blocked: messageType=registerMediaServer, reason=registrationId is required",
        );
      }
      throw new Error(
        "registerMediaServer blocked: reason=registrationId is required",
      );
    }

    if (registrationId === "signaling") {
      if (errorScope === "incomingNetsocketCommand") {
        throw new Error(
          "incomingNetsocketCommand blocked: messageType=registerMediaServer, reason=reserved node id 'signaling' is not valid for media servers",
        );
      }
      throw new Error(
        "registerMediaServer blocked: reason=reserved node id 'signaling' is not valid for media servers",
      );
    }

    if (registrationId !== node) {
      if (errorScope === "incomingNetsocketCommand") {
        throw new Error(
          `incomingNetsocketCommand blocked: node=${node}, messageType=registerMediaServer, reason=message.registrationId must match envelope node, registrationId=${registrationId}`,
        );
      }
      throw new Error(
        `registerMediaServer blocked: node=${node}, reason=message.registrationId must match envelope node, registrationId=${registrationId}`,
      );
    }

    return registrationId;
  }

  /**
   * Ensures connection identity (if present) matches requested registration tuple.
   *
   * @param params - Connection + requested identity tuple.
   * @returns `void`.
   * @throws {Error} When connection is already registered as a different identity.
   */
  private assertConnectionRegistrationConsistency(params: {
    connection: ConnectionRef;
    serverId: Guid;
    mode: MediaServerMode;
    errorScope: "incomingNetsocketCommand" | "registerMediaServer";
  }) {
    const { connection, serverId, mode, errorScope } = params;
    const existingIdentity =
      this.context.connectionRegistry.getIdentity(connection);
    if (
      existingIdentity &&
      (existingIdentity.serverId !== serverId || existingIdentity.mode !== mode)
    ) {
      if (errorScope === "incomingNetsocketCommand") {
        throw new Error(
          `incomingNetsocketCommand blocked: node=${serverId}, messageType=registerMediaServer, reason=connection already registered as serverId=${existingIdentity.serverId}, mode=${existingIdentity.mode}`,
        );
      }
      throw new Error(
        `registerMediaServer blocked: serverId=${serverId}, mode=${mode}, reason=connection already registered as serverId=${existingIdentity.serverId}, mode=${existingIdentity.mode}`,
      );
    }
  }

  /**
   * Enforces that a netsocket payload belongs to the registered server identity.
   *
   * `registerMediaServer` is handled as the bootstrap exception before identity
   * can be considered established.
   *
   * @param node - Envelope node id supplied by the inbound netsocket frame.
   * @param payload - Parsed inbound media payload to validate.
   * @param connection - Netsocket connection that delivered the payload.
   * @returns `void`.
   * @throws {Error} When the payload identity/mode does not match registered connection identity.
   */
  validateNetsocketIdentity(
    node: NodeId,
    payload: MediaInboundPayload,
    connection: ConnectionRef,
  ) {
    if (payload.type === "registerMediaServer") {
      const registrationId = this.requireRegisterMediaServerIdentity({
        node,
        registrationId: payload.message.registrationId,
        errorScope: "incomingNetsocketCommand",
      });
      this.assertConnectionRegistrationConsistency({
        connection,
        serverId: registrationId,
        mode: payload.message.mode,
        errorScope: "incomingNetsocketCommand",
      });
      return;
    }

    const existingIdentity =
      this.context.connectionRegistry.getIdentity(connection);
    if (!existingIdentity) {
      throw new Error(
        `incomingNetsocketCommand blocked: node=${node}, messageType=${payload.type}, reason=connection must registerMediaServer before sending messages`,
      );
    }

    if (node !== existingIdentity.serverId) {
      throw new Error(
        `incomingNetsocketCommand blocked: node=${node}, messageType=${payload.type}, reason=node id does not match registered connection identity, registeredServerId=${existingIdentity.serverId}`,
      );
    }

    if (
      (payload.type === "unregisterMediaServer" ||
        payload.type === "serverLoad" ||
        payload.type === "mediaDiagnostic") &&
      payload.message.mode !== existingIdentity.mode
    ) {
      throw new Error(
        `incomingNetsocketCommand blocked: node=${node}, messageType=${payload.type}, reason=mode does not match registered connection mode, registeredMode=${existingIdentity.mode}, messageMode=${payload.message.mode}`,
      );
    }
  }

  /**
   * Ensures requested server registration does not conflict with other sockets.
   *
   * @param params - Requested registration tuple and connection.
   * @returns `void`.
   * @throws {Error} When same server id is already bound to another connection.
   */
  private assertMediaServerRegistrationAvailable(params: {
    serverId: Guid;
    mode: MediaServerMode;
    connection: ConnectionRef;
  }) {
    const { serverId, mode, connection } = params;
    const existingIngress = this.getRegisteredServerConnection(
      serverId,
      "ingress",
    );
    const existingEgress = this.getRegisteredServerConnection(
      serverId,
      "egress",
    );
    const conflictsByMode: Record<
      MediaServerMode,
      Array<{ existing: ConnectionRef | undefined; reason: string }>
    > = {
      ingress: [
        {
          existing: existingIngress,
          reason:
            "server id already registered on a different ingress connection",
        },
        {
          existing: existingEgress,
          reason:
            "server id already registered as egress on a different connection",
        },
      ],
      egress: [
        {
          existing: existingEgress,
          reason:
            "server id already registered on a different egress connection",
        },
        {
          existing: existingIngress,
          reason:
            "server id already registered as ingress on a different connection",
        },
      ],
    };

    for (const conflict of conflictsByMode[mode]) {
      if (conflict.existing && conflict.existing !== connection) {
        throw new Error(
          `registerMediaServer blocked: serverId=${serverId}, mode=${mode}, reason=${conflict.reason}`,
        );
      }
    }
  }

  /**
   * Registers one media server connection into region and load indexes.
   *
   * @param connection - Netsocket connection associated with the media server.
   * @param node - Envelope node id.
   * @param message - Registration payload from media.
   * @returns `void`.
   * @throws {Error} When identity constraints are violated or registration conflicts exist.
   */
  registerMediaServer(
    connection: ConnectionRef,
    node: NodeId,
    message: MediaInboundMessageMap["registerMediaServer"],
  ) {
    const serverId = this.requireRegisterMediaServerIdentity({
      node,
      registrationId: message.registrationId,
      errorScope: "registerMediaServer",
    });
    this.assertConnectionRegistrationConsistency({
      connection,
      serverId,
      mode: message.mode,
      errorScope: "registerMediaServer",
    });
    this.assertMediaServerRegistrationAvailable({
      serverId,
      mode: message.mode,
      connection,
    });
    this.context.connectionRegistry.setServerConnection(
      serverId,
      message.mode,
      connection,
    );
    this.context.serverRegistry.registerServer(
      message.mode,
      message.region,
      serverId,
    );
    traceMediaServerLifecycle("registered", {
      serverId,
      mode: message.mode,
      region: message.region,
    });
    this.context.connectionRegistry.setIdentity(connection, {
      serverId,
      mode: message.mode,
    });
    delete this.context.serverOfflineEvents[serverId];
  }

  /**
   * Resolves registered identity for a connection.
   *
   * @param connection - Netsocket connection.
   * @param messageType - Calling message type for error context.
   * @returns Registered media-server identity.
   * @throws {Error} When connection is not registered.
   */
  private requireRegisteredIdentity(
    connection: ConnectionRef,
    messageType: string,
  ): MediaServerRegistration {
    const registeredIdentity =
      this.context.connectionRegistry.getIdentity(connection);
    if (!registeredIdentity) {
      throw new Error(
        `${messageType} blocked: reason=connection is not registered`,
      );
    }
    return registeredIdentity;
  }

  /**
   * Unregisters one media server and tears down dependent signaling state.
   *
   * @param connection - Netsocket connection requesting unregistration.
   * @param message - Unregistration payload from media.
   * @returns `void`.
   * @throws {Error} When the connection is not the registered connection for that server/mode.
   */
  unregisterMediaServer(
    connection: ConnectionRef,
    message: MediaInboundMessageMap["unregisterMediaServer"],
  ) {
    const { serverId } = this.requireRegisteredIdentity(
      connection,
      "unregisterMediaServer",
    );
    const registeredConnection = this.getRegisteredServerConnection(
      serverId,
      message.mode,
    );
    if (registeredConnection !== connection) {
      throw new Error(
        `unregisterMediaServer blocked: serverId=${serverId}, mode=${message.mode}, reason=connection does not match registered socket`,
      );
    }

    this.ejectMediaServer({
      serverId,
      mode: message.mode,
      graceful: true,
      trigger: "unregisterMediaServer",
      region: message.region,
      reason: message.reason ?? "server_requested_unregistration",
      detail: message.detail,
    });
  }

  /**
   * Records one server-load heartbeat in the media-server registry.
   *
   * @param connection - Netsocket connection that emitted the load update.
   * @param message - Load snapshot payload.
   * @returns `void`.
   * @throws {Error} When the connection is not registered.
   */
  recordServerLoad(
    connection: ConnectionRef,
    message: MediaInboundMessageMap["serverLoad"],
  ) {
    const { serverId } = this.requireRegisteredIdentity(
      connection,
      "serverLoad",
    );
    this.context.serverRegistry.setServerLoadSnapshot(
      message.mode,
      message.region,
      serverId,
      message.load,
      message.loadPerCpu,
    );
  }

  /**
   * Records a diagnostic emitted by media into the shared diagnostics sink.
   *
   * @param connection - Netsocket connection that emitted the diagnostic.
   * @param message - Diagnostic payload.
   * @returns `void`.
   * @throws {Error} When the connection is not registered.
   */
  recordMediaDiagnostic(
    connection: ConnectionRef,
    message: MediaInboundMessageMap["mediaDiagnostic"],
  ) {
    const { serverId } = this.requireRegisteredIdentity(
      connection,
      "mediaDiagnostic",
    );
    this.context.recordDiagnostic({
      severity: message.severity,
      category: message.category,
      message: message.message,
      details: message.details,
      context: {
        serverId,
        mode: message.mode,
        region: message.region,
        ...(message.context ?? {}),
      },
    });
  }
}
