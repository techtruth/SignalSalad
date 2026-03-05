/**
 * Runtime system-status aggregation and broadcast service.
 *
 * It periodically snapshots signaling runtime state, enriches with router-dump
 * topology details, and publishes `systemStatus` messages to `/status`
 * subscribers.
 */
import type { Guid, Peer } from "../../../types/baseTypes.d.ts";
import type { SystemDiagnosticEvent } from "../../../types/wsRelay.d.ts";
import type { RouterDump as MediaRouterDumpMessage } from "../../../types/nsRelay.d.ts";
import type { PeerSessions } from "../core/peer/peerSessions.js";
import type { ProducerRegistry } from "../core/peer/producerRegistry.js";
import type { SignalingMessenger } from "../protocol/signalingMessenger.js";
import type {
  NsMessageMap,
  WsMessageMap,
} from "../protocol/signalingIoValidation.js";
import type {
  RoutingTableItems,
  MediaServerPipe,
} from "../protocol/signalingTypes.js";
import { buildDumpRouterGroupMessage } from "../protocol/netsocketMessageBuilders.js";
import uuid from "uuid4";

/**
 * Tracks an in-flight router-dump fanout request keyed by generated `origin`.
 *
 * `expected` holds room/mode/server keys still pending; completion occurs once
 * it reaches zero or the timeout/reject path triggers.
 */
type PendingRouterDumpRequest = {
  expected: Set<string>;
  received: Map<string, MediaRouterDumpMessage>;
  resolve: (dumps: Map<string, MediaRouterDumpMessage>) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

/** Normalized router-dump tuple used to reconstruct ingress<->egress pipes. */
type RouterDumpPipe = {
  room: string;
  serverId: Guid;
  localPort: number;
  remotePort: number;
};

/**
 * Runtime dependencies consumed by `StatusReporter`.
 *
 * This is intentionally a read-model style context that references state owned
 * elsewhere (sessions, routing, producer registry, transport maps).
 */
export type StatusReporterContext = {
  peers: Map<Guid, Peer>;
  sessions: PeerSessions;
  producers: ProducerRegistry;
  wsClients: Map<Guid, unknown>;
  statusSubscribers: Set<Guid>;
  ingress: ReadonlyMap<Guid, unknown>;
  egress: ReadonlyMap<Guid, unknown>;
  ingressRegions: { [key: string]: string[] };
  egressRegions: { [key: string]: string[] };
  routingTable: Map<string, RoutingTableItems>;
  ingressLoad: { [region: string]: { [ingressServer: string]: number } };
  egressLoad: { [region: string]: { [egressServer: string]: number } };
  ingressLoadDetail: {
    [region: string]: {
      [ingressServer: string]: { avg: number; perCpu: number[] };
    };
  };
  egressLoadDetail: {
    [region: string]: {
      [egressServer: string]: { avg: number; perCpu: number[] };
    };
  };
  pipes: MediaServerPipe[];
  serverOfflineEvents: {
    [serverId: string]: {
      mode: "ingress" | "egress";
      region?: string;
      graceful: boolean;
      reason?: string;
      detail?: string;
      trigger: string;
      at: string;
    };
  };
  diagnosticsRecent: () => SystemDiagnosticEvent[];
  recordDiagnostic?: (event: Omit<SystemDiagnosticEvent, "at">) => void;
  signalingMessenger: SignalingMessenger;
};

/** Minimal shape required to prune an unhealthy status websocket. */
type ClosableWebSocketLike = {
  close: (code?: number, reason?: string) => void;
};

/**
 * Builds a stable key for cached router-dump snapshots within a room+mode+server scope.
 *
 * @param room Room id.
 * @param mode Media-server mode.
 * @param serverId Media-server id.
 * @returns Stable tuple key for map indexing.
 */
const routerGroupKey = (room: string, mode: string, serverId: string) =>
  `${room}:${mode}:${serverId}`;

/**
 * Narrows unknown websocket map entries into close-capable sockets.
 *
 * Status reporter keeps weak coupling with the websocket layer to avoid a hard
 * runtime dependency on concrete websocket implementations.
 *
 * @param value Unknown websocket map entry.
 * @returns Close-capable websocket-like object when shape matches.
 */
const asClosableWebSocket = (
  value: unknown,
): ClosableWebSocketLike | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = value as Partial<ClosableWebSocketLike>;
  if (typeof candidate.close !== "function") {
    return undefined;
  }
  return candidate as ClosableWebSocketLike;
};

/** Periodic interval for `systemStatus` snapshots. */
const STATUS_BROADCAST_INTERVAL_MS = 5000;
/** Timeout for receiving all requested router dumps in one status cycle. */
const ROUTER_DUMP_TIMEOUT_MS = 2000;

/**
 * Reconstructs active ingress->egress pipe pairs from per-server router dumps so status
 * consumers can see current inter-server media relay topology.
 *
 * @param routerDumps Router dump snapshots keyed by room/mode/server.
 * @returns Derived ingress<->egress pipe list.
 */
const buildPipesFromRouterDumps = (
  routerDumps: Map<string, MediaRouterDumpMessage>,
): MediaServerPipe[] => {
  const ingressPipes = new Array<RouterDumpPipe>();
  const egressPipes = new Array<RouterDumpPipe>();
  for (const dump of routerDumps.values()) {
    const pipeTransports = Array.isArray(dump.pipeTransports)
      ? dump.pipeTransports
      : [];
    for (const pipe of pipeTransports) {
      const tuple = pipe.tuple;
      if (!tuple) {
        continue;
      }
      const localPort = Number(tuple.localPort);
      const remotePort = Number(tuple.remotePort);
      if (!Number.isFinite(localPort) || !Number.isFinite(remotePort)) {
        continue;
      }
      const entry = {
        room: dump.room,
        serverId: dump.serverId,
        localPort,
        remotePort,
      };
      if (dump.mode === "ingress") {
        ingressPipes.push(entry);
      } else {
        egressPipes.push(entry);
      }
    }
  }

  const results = new Array<MediaServerPipe>();
  const seen = new Set<string>();
  for (const ingressPipe of ingressPipes) {
    for (const egressPipe of egressPipes) {
      if (ingressPipe.room !== egressPipe.room) {
        continue;
      }
      if (
        ingressPipe.remotePort !== egressPipe.localPort ||
        ingressPipe.localPort !== egressPipe.remotePort
      ) {
        continue;
      }
      const key = [
        ingressPipe.room,
        ingressPipe.serverId,
        egressPipe.serverId,
        ingressPipe.localPort,
        egressPipe.localPort,
      ].join(":");
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      results.push({
        ingress: ingressPipe.serverId,
        egress: egressPipe.serverId,
        room: ingressPipe.room,
        ingressPort: ingressPipe.localPort,
        egressPort: egressPipe.localPort,
        producerIds: new Array<string>(),
      });
    }
  }
  return results;
};

/**
 * Periodically publishes signaling runtime state to `/status` subscribers.
 *
 * This class is the read-model for operational visibility: peer/session snapshots,
 * media server load maps, routing assignments, and discovered network-pipe links.
 */
export class StatusReporter {
  private context: StatusReporterContext;
  private statusInterval: ReturnType<typeof setInterval> | undefined;
  private statusInFlight: boolean;
  private routerDumps: Map<string, MediaRouterDumpMessage>;
  private pendingRouterDumpRequests: Map<string, PendingRouterDumpRequest>;

  /**
   * @param context Runtime read-model dependencies used for status snapshots.
   */
  constructor(context: StatusReporterContext) {
    this.context = context;
    this.statusInterval = undefined;
    this.statusInFlight = false;
    this.routerDumps = new Map();
    this.pendingRouterDumpRequests = new Map();
  }

  /** Records a status-related diagnostic via the shared diagnostic sink. */
  private recordStatusDiagnostic(event: Omit<SystemDiagnosticEvent, "at">) {
    this.context.recordDiagnostic?.(event);
  }

  /**
   * Starts periodic status publishing.
   *
   * Invoking start multiple times is idempotent; only one interval is active.
   *
   * @returns `void`.
   */
  start() {
    if (!this.statusInterval) {
      void this.broadcastStatus();
      this.statusInterval = setInterval(() => {
        void this.broadcastStatus();
      }, STATUS_BROADCAST_INTERVAL_MS);
      if (typeof this.statusInterval.unref === "function") {
        this.statusInterval.unref();
      }
    }
  }

  /**
   * Stops periodic publishing and rejects all in-flight router-dump requests.
   *
   * @returns `void`.
   */
  stop() {
    if (this.statusInterval) {
      clearInterval(this.statusInterval);
      this.statusInterval = undefined;
    }
    this.cancelPendingRouterDumpRequests("Status reporter stopped");
  }

  /**
   * Ingests a router dump response and resolves/rejects pending request state
   * when all expected room/mode/server keys are satisfied.
   *
   * @param message Router dump callback payload.
   */
  handleRouterDump(message: MediaRouterDumpMessage) {
    const key = routerGroupKey(message.room, message.mode, message.serverId);
    const pending = this.pendingRouterDumpRequests.get(message.origin);
    if (pending && pending.expected.has(key)) {
      pending.expected.delete(key);
      pending.received.set(key, message);
      if (message.error) {
        clearTimeout(pending.timeoutId);
        this.pendingRouterDumpRequests.delete(message.origin);
        pending.reject(
          new Error(`Router dump error for ${key}: ${message.error}`),
        );
      } else if (pending.expected.size === 0) {
        clearTimeout(pending.timeoutId);
        this.pendingRouterDumpRequests.delete(message.origin);
        pending.resolve(pending.received);
      }
    }
    this.routerDumps.set(key, message);
  }

  /**
   * Removes cached router dumps belonging to a deleted/emptied room.
   *
   * @param room Deleted or emptied room id.
   */
  clearRoomRouterDumps(room: string) {
    for (const key of this.routerDumps.keys()) {
      if (key.startsWith(`${room}:`)) {
        this.routerDumps.delete(key);
      }
    }
  }

  /**
   * Removes cached router dumps tied to an ejected/disconnected server.
   *
   * @param serverId Ejected/disconnected server id.
   */
  clearServerRouterDumps(serverId: Guid) {
    for (const [key, dump] of this.routerDumps.entries()) {
      if (dump.serverId === serverId || key.endsWith(`:${serverId}`)) {
        this.routerDumps.delete(key);
      }
    }
  }

  /**
   * Removes a status subscriber after send failure and closes its socket when
   * possible to avoid repeated failing sends.
   *
   * @param wsid Status subscriber websocket id.
   */
  private pruneStatusSubscriber(wsid: Guid) {
    const socket = asClosableWebSocket(this.context.wsClients.get(wsid));
    if (socket) {
      try {
        socket.close(1011, "status subscriber pruned");
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.recordStatusDiagnostic({
          severity: "warn",
          category: "websocketRequest",
          message: "status subscriber close during prune failed",
          details: `wsid=${wsid}, error=${errorMessage}`,
          context: {
            wsid,
          },
        });
      }
    }
    this.context.statusSubscribers.delete(wsid);
    this.context.wsClients.delete(wsid);
  }

  /**
   * Rejects all pending router-dump promises with a shared reason.
   *
   * @param reason Shared rejection reason prefix.
   */
  private cancelPendingRouterDumpRequests(reason: string) {
    for (const [origin, pending] of this.pendingRouterDumpRequests.entries()) {
      clearTimeout(pending.timeoutId);
      pending.reject(new Error(`${reason}: origin=${origin}`));
    }
    this.pendingRouterDumpRequests.clear();
  }

  /**
   * Dispatches `dumpRouterGroup` requests for all currently routed room/server
   * combinations and resolves with collected dumps for the status cycle.
   *
   * @returns Promise of collected router dumps keyed by room/mode/server.
   */
  private async requestRouterDumpsForStatus(): Promise<
    Map<string, MediaRouterDumpMessage>
  > {
    const origin = `status:${uuid()}`;
    const requested = new Set<string>();
    const payloads = new Array<{
      mode: "ingress" | "egress";
      serverId: Guid;
      message: NsMessageMap["dumpRouterGroup"];
    }>();

    for (const [room, routerGroup] of this.context.routingTable.entries()) {
      for (const ingressId of routerGroup.ingress) {
        const key = routerGroupKey(room, "ingress", ingressId);
        if (requested.has(key)) continue;
        requested.add(key);
        const message = buildDumpRouterGroupMessage(origin, room);
        payloads.push({
          mode: "ingress",
          serverId: ingressId,
          message,
        });
      }
      for (const egressId of routerGroup.egress) {
        const key = routerGroupKey(room, "egress", egressId);
        if (requested.has(key)) continue;
        requested.add(key);
        const message = buildDumpRouterGroupMessage(origin, room);
        payloads.push({
          mode: "egress",
          serverId: egressId,
          message,
        });
      }
    }

    if (requested.size === 0) {
      return new Map();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRouterDumpRequests.delete(origin);
        reject(new Error("Status router dump timed out"));
      }, ROUTER_DUMP_TIMEOUT_MS);
      if (typeof timeoutId.unref === "function") {
        timeoutId.unref();
      }

      this.pendingRouterDumpRequests.set(origin, {
        expected: requested,
        received: new Map(),
        resolve,
        reject,
        timeoutId,
      });

      try {
        payloads.forEach(({ mode, serverId, message }) => {
          if (mode === "ingress") {
            this.context.signalingMessenger.sendNetsocketMessage(
              serverId,
              "ingress",
              "dumpRouterGroup",
              message,
            );
          } else {
            this.context.signalingMessenger.sendNetsocketMessage(
              serverId,
              "egress",
              "dumpRouterGroup",
              message,
            );
          }
        });
      } catch (error) {
        clearTimeout(timeoutId);
        this.pendingRouterDumpRequests.delete(origin);
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.recordStatusDiagnostic({
          severity: "warn",
          category: "netsocketCommand",
          message: "status router dump dispatch failed",
          details: `origin=${origin}, error=${errorMessage}`,
          context: {
            origin,
          },
        });
        reject(
          new Error(`Status router dump dispatch failed: ${errorMessage}`),
        );
      }
    });
  }

  /**
   * Builds and broadcasts a `systemStatus` snapshot to all status subscribers.
   *
   * Calls are serialized by `statusInFlight` to avoid overlapping dump request
   * windows and duplicated high-cost status assembly work.
   *
   * @returns Promise resolved when one broadcast cycle completes.
   */
  private async broadcastStatus() {
    if (this.context.statusSubscribers.size === 0) {
      this.stop();
      return;
    }
    if (this.statusInFlight) {
      return;
    }
    this.statusInFlight = true;
    try {
      const routerDumps = await this.requestRouterDumpsForStatus();
      const rawRouterDumps = Object.fromEntries(routerDumps);
      const peersStatus: Record<Guid, Peer> = {};
      for (const [peerId, peer] of this.context.peers.entries()) {
        peersStatus[peerId] = {
          ...peer,
          mediaProducers: this.context.producers.getPeerMediaProducers(peerId),
        };
      }
      const statusMessage: WsMessageMap["systemStatus"] = {
        wsClients: [...this.context.wsClients.keys()],
        ingress: [...this.context.ingress.keys()],
        egress: [...this.context.egress.keys()],
        ingressRegions: this.context.ingressRegions,
        egressRegions: this.context.egressRegions,
        routingTable: Object.fromEntries(this.context.routingTable),
        ingressLoad: this.context.ingressLoad,
        egressLoad: this.context.egressLoad,
        ingressLoadDetail: this.context.ingressLoadDetail,
        egressLoadDetail: this.context.egressLoadDetail,
        pipesObserved: buildPipesFromRouterDumps(routerDumps),
        pipes: this.context.pipes,
        routerDumps: rawRouterDumps,
        serverOfflineEvents: this.context.serverOfflineEvents,
        diagnosticsRecent: this.context.diagnosticsRecent(),
        originID_to_peerID: this.context.sessions.getOriginIndex(),
        egressTransportID_to_peerID:
          this.context.sessions.getEgressTransportIndex(),
        peers: peersStatus,
      };

      for (const wsid of this.context.statusSubscribers) {
        try {
          this.context.signalingMessenger.sendWebsocketMessage(
            wsid,
            "systemStatus",
            statusMessage,
          );
        } catch (error) {
          this.pruneStatusSubscriber(wsid);
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          this.recordStatusDiagnostic({
            severity: "warn",
            category: "websocketRequest",
            message: "status subscriber send failed",
            details: `wsid=${wsid}, error=${errorMessage}`,
            context: {
              wsid,
              messageType: "systemStatus",
            },
          });
          console.warn(
            `Failed to send systemStatus to status subscriber ${wsid}: ${
              errorMessage
            }. Pruned subscriber from status stream.`,
          );
        }
      }
      if (this.context.statusSubscribers.size === 0) {
        this.stop();
      }
    } catch (error) {
      this.recordStatusDiagnostic({
        severity: "warn",
        category: "netsocketCommand",
        message: "status update failed",
        details: error instanceof Error ? error.message : String(error),
        context: {
          messageType: "systemStatus",
        },
      });
      console.error("Status update failed", error);
    } finally {
      this.statusInFlight = false;
    }
  }
}
