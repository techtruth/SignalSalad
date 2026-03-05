// SFU - Selective Forwarding Unit
import * as os from "os";
import { createWorker } from "mediasoup";
import type {
  Worker,
  Router,
  WebRtcTransport,
  Consumer,
  Producer,
  PipeTransport,
  WebRtcServer,
  WebRtcServerOptions,
  MediaKind,
  AppData,
  RtpParameters,
  NumSctpStreams,
  DtlsParameters,
  RtpCapabilities,
  RtpCodecCapability,
} from "mediasoup/types";
// Note: mediasoup type names use `WebRtc*` casing.

import type { CreatedMediaConsumer as MediaConsumers } from "../../types/nsRelay.d.ts";
import type {
  PipeTransportDump,
  RouterDumpWarning,
  RouterDump,
  StatTotals,
} from "./sfuDumpStats.js";
import { collectRouterDumpStats } from "./sfuDumpStats.js";
import {
  buildPipeTransportKey,
  closePipeProducerRelay,
  consumeNetworkPipeTransportRelay,
  createNetworkPipeTransportEgressRelay,
  createNetworkPipeTransportIngressRelay,
  finalizeNetworkPipeTransportRelay,
  produceNetworkPipeTransportRelay,
} from "./sfuRelay.js";

/**
 * Router-group dump payload returned by `dumpRouterGroup`.
 *
 * Combines per-router graph snapshots with transport stats so diagnostics/status
 * views can reconstruct relay topology and throughput.
 */
export type RouterGroupDump = {
  routers: Array<RouterDump & { transportStats?: StatTotals }>;
  pipeTransports: PipeTransportDump[];
  webrtcTransportStats: Record<string, StatTotals>;
  pipeTransportStats: Record<string, StatTotals>;
};

/** Worker load snapshot used by least-loaded worker selection. */
export type WorkerLoadSnapshot = {
  workerIndex: number;
  cpuUsageTotal: number;
  assignedRooms: number;
};

const DEFAULT_MEDIA_WORKER_OMIT_CPUS = 2;

/**
 * Resolves worker count from available CPUs and optional omit configuration.
 *
 * @param availableCpus - Number of CPUs detected by runtime.
 * @param omitCpusValue - Optional `MEDIA_WORKER_OMIT_CPUS` override.
 * @returns Worker count clamped to at least `1`.
 * @throws {Error} When omit value is not a non-negative integer.
 */
export const resolveMediaWorkerCount = (
  availableCpus: number,
  omitCpusValue: string | undefined,
) => {
  const cpuCount = Number.isFinite(availableCpus)
    ? Math.max(1, Math.floor(availableCpus))
    : 1;
  let omitCpus = DEFAULT_MEDIA_WORKER_OMIT_CPUS;
  if (typeof omitCpusValue === "string" && omitCpusValue.trim().length > 0) {
    const parsed = Number(omitCpusValue);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(
        `Invalid MEDIA_WORKER_OMIT_CPUS value '${omitCpusValue}'. Expected a non-negative integer.`,
      );
    }
    omitCpus = parsed;
  }
  return Math.max(1, cpuCount - omitCpus);
};

const extractWorkerCpuUsageTotal = (usage: unknown) => {
  if (!usage || typeof usage !== "object") {
    return Number.POSITIVE_INFINITY;
  }
  const record = usage as Record<string, unknown>;
  const userTime =
    typeof record.ru_utime === "number" ? record.ru_utime : Number.NaN;
  const systemTime =
    typeof record.ru_stime === "number" ? record.ru_stime : Number.NaN;
  if (!Number.isFinite(userTime) || !Number.isFinite(systemTime)) {
    return Number.POSITIVE_INFINITY;
  }
  return userTime + systemTime;
};

/**
 * Picks least-loaded worker index from current load snapshots.
 *
 * @param snapshots - Worker load snapshots.
 * @returns Selected worker index.
 * @throws {Error} When snapshot list is empty.
 */
export const chooseLeastLoadedWorkerIndex = (
  snapshots: WorkerLoadSnapshot[],
) => {
  if (!snapshots.length) {
    throw new Error("Cannot choose worker from empty snapshot list");
  }
  const sorted = [...snapshots].sort((a, b) => {
    if (a.cpuUsageTotal !== b.cpuUsageTotal) {
      return a.cpuUsageTotal - b.cpuUsageTotal;
    }
    if (a.assignedRooms !== b.assignedRooms) {
      return a.assignedRooms - b.assignedRooms;
    }
    return a.workerIndex - b.workerIndex;
  });
  return sorted[0].workerIndex;
};

/**
 * In-process SFU runtime for one media node (ingress or egress mode).
 *
 * Owns mediasoup workers, routers, WebRTC transports, producers/consumers,
 * and cross-node networkpiperelay resources.
 */
export class SFU {
  mode: "ingress" | "egress";
  mediaCodecs: RtpCodecCapability[];
  workers: Worker[];
  transports: Map<string, WebRtcTransport>;
  consumers: Map<string, Consumer>;
  producers: Map<string, Producer>;
  onProducerClosed:
    | ((producerId: string, kind: MediaKind, appData?: AppData) => void)
    | undefined;
  onTransportClosed:
    | ((transportId: string, direction: "ingress" | "egress") => void)
    | undefined;
  networkPipeTransports: Map<string, PipeTransport>;
  pipeProducers: Map<string, Producer>;
  consumerIndexByTransportProducer: Map<string, string>;
  webRtcServers: WebRtcServer[];
  routerGroups: Map<string, Router[]>;
  transportRouterIds: Map<string, string>;
  transportRoomNames: Map<string, string>;
  producerRouterIds: Map<string, string>;
  producerRoomNames: Map<string, string>;
  localPipedProducerTargets: Map<string, Set<string>>;
  networkPipeTransportRouterIds: Map<string, string>;
  announcedIp: string | undefined;

  // Constructor should not start the media process
  constructor(mode: "ingress" | "egress", announcedIp?: string) {
    this.workers = new Array<Worker>();
    this.webRtcServers = new Array<WebRtcServer>();
    this.transports = new Map<string, WebRtcTransport>();
    this.consumers = new Map<string, Consumer>();
    this.producers = new Map<string, Producer>();
    this.onProducerClosed = undefined;
    this.onTransportClosed = undefined;
    this.networkPipeTransports = new Map<string, PipeTransport>();
    this.pipeProducers = new Map<string, Producer>();
    this.consumerIndexByTransportProducer = new Map<string, string>();
    this.routerGroups = new Map<string, Router[]>();
    this.transportRouterIds = new Map<string, string>();
    this.transportRoomNames = new Map<string, string>();
    this.producerRouterIds = new Map<string, string>();
    this.producerRoomNames = new Map<string, string>();
    this.localPipedProducerTargets = new Map<string, Set<string>>();
    this.networkPipeTransportRouterIds = new Map<string, string>();
    this.announcedIp = announcedIp;
    this.mode = mode;

    // Docs baseline codecs: Opus + VP8.
    this.mediaCodecs = new Array<RtpCodecCapability>(
      {
        kind: "audio",
        mimeType: "audio/opus",
        clockRate: 48000,
        channels: 2,
        preferredPayloadType: 111,
        parameters: {
          maxaveragebitrate: 32000,
          "sprop-maxcapturerate": 16000,
          useinbandfec: 1,
          usedtx: 1,
        },
      },
      {
        kind: "video",
        mimeType: "video/VP8",
        clockRate: 90000,
        preferredPayloadType: 96,
        parameters: {
          "x-google-start-bitrate": 1000,
        },
        rtcpFeedback: [
          { type: "nack" },
          { type: "nack", parameter: "pli" },
          { type: "ccm", parameter: "fir" },
          { type: "goog-remb" },
          { type: "transport-cc" },
        ],
      },
      {
        kind: "video",
        mimeType: "video/H264",
        clockRate: 90000,
        preferredPayloadType: 102,
        parameters: {
          "packetization-mode": 1,
          "profile-level-id": "42e01f",
          "level-asymmetry-allowed": 1,
          "x-google-start-bitrate": 1000,
        },
        rtcpFeedback: [
          { type: "nack" },
          { type: "nack", parameter: "pli" },
          { type: "ccm", parameter: "fir" },
          { type: "goog-remb" },
          { type: "transport-cc" },
        ],
      },
    );
  }

  // Lifecycle ---------------------------------------------------------------

  private resolveWebRtcListenInfos() {
    const listenInfos = new Array<WebRtcServerOptions["listenInfos"][number]>();

    if (this.announcedIp) {
      listenInfos.push({
        protocol: "udp",
        ip: "0.0.0.0",
        announcedIp: this.announcedIp,
      });
      return listenInfos;
    }

    const networkInterfaces = os.networkInterfaces();
    for (const interfaces of Object.values(networkInterfaces)) {
      if (!interfaces) {
        continue;
      }
      for (const iface of interfaces) {
        if (iface.family === "IPv4" && !iface.internal) {
          listenInfos.push({
            protocol: "udp",
            ip: iface.address,
          });
        }
      }
    }
    return listenInfos;
  }

  // Initialize media server
  async initialize() {
    const rtcMinPortEnv = process.env.RTC_MIN_PORT;
    const rtcMaxPortEnv = process.env.RTC_MAX_PORT;
    if (!rtcMinPortEnv || !rtcMaxPortEnv) {
      throw new Error(
        "RTC_MIN_PORT and RTC_MAX_PORT must be set for media server RTC range",
      );
    }
    const rtcMinPort = Number(rtcMinPortEnv);
    const rtcMaxPort = Number(rtcMaxPortEnv);
    if (!Number.isFinite(rtcMinPort) || !Number.isFinite(rtcMaxPort)) {
      throw new Error(
        `Invalid RTC port range (RTC_MIN_PORT=${rtcMinPortEnv}, RTC_MAX_PORT=${rtcMaxPortEnv})`,
      );
    }
    const workerCount = resolveMediaWorkerCount(
      os.cpus().length,
      process.env.MEDIA_WORKER_OMIT_CPUS,
    );
    const listenInfos = this.resolveWebRtcListenInfos();
    for (let i = 0; i < workerCount; i++) {
      this.workers[i] = await createWorker({
        rtcMinPort,
        rtcMaxPort,
        logLevel: "debug",
        logTags: [
          "info",
          "ice",
          "dtls",
          "rtp",
          "srtp",
          "rtcp",
          "rtx",
          "bwe",
          "score",
          "simulcast",
          "svc",
          "sctp",
          "message",
        ],
        appData: {
          cpu: i,
        },
      });

      this.webRtcServers[i] = await this.workers[i].createWebRtcServer({
        listenInfos,
      });
      console.log("WebRTC listening on", listenInfos);
    }
    console.log("Initialized", this.workers.length, this.mode, "workers");
  }

  async reset() {
    //Close all workers
    for (const worker of this.workers) {
      if (!worker.closed) {
        console.log("Resetting worker", await worker.getResourceUsage());
        worker.close();
      }
    }
    this.workers = new Array<Worker>();

    //All these close when the worker closes
    this.transports = new Map<string, WebRtcTransport>();
    this.consumers = new Map<string, Consumer>();
    this.producers = new Map<string, Producer>();
    this.networkPipeTransports = new Map<string, PipeTransport>();
    this.webRtcServers = new Array<WebRtcServer>();
    this.routerGroups = new Map<string, Router[]>();
    this.transportRouterIds = new Map<string, string>();
    this.transportRoomNames = new Map<string, string>();
    this.producerRouterIds = new Map<string, string>();
    this.producerRoomNames = new Map<string, string>();
    this.localPipedProducerTargets = new Map<string, Set<string>>();
    this.networkPipeTransportRouterIds = new Map<string, string>();
    this.consumerIndexByTransportProducer = new Map<string, string>();

    //Start sfu over again
    await this.initialize();
  }

  // WebRTC transport tracking ----------------------------------------------

  private resolveRouterWorkerIndex(router: Router) {
    if (!router.appData || typeof router.appData !== "object") {
      return undefined;
    }
    const value = (router.appData as Record<string, unknown>).workerIndex;
    return typeof value === "number" && Number.isInteger(value)
      ? value
      : undefined;
  }

  private getRouterWorkerIndexOrThrow(
    router: Router,
    context: string,
    routerNetwork: string,
  ) {
    const workerIndex = this.resolveRouterWorkerIndex(router);
    if (
      workerIndex === undefined ||
      workerIndex < 0 ||
      workerIndex >= this.workers.length
    ) {
      throw new Error(
        `Cannot locate worker assignment for ${routerNetwork} when ${context}`,
      );
    }
    return workerIndex;
  }

  private getRoomRoutersOrThrow(routerNetwork: string, context: string) {
    const existing = this.routerGroups.get(routerNetwork);
    if (!existing || !existing.length) {
      throw new Error(
        `Cannot locate router group for ${routerNetwork} when ${context}`,
      );
    }
    const activeRouters = existing.filter((router) => !router.closed);
    if (!activeRouters.length) {
      throw new Error(
        `Cannot locate active router for ${routerNetwork} when ${context}`,
      );
    }
    if (activeRouters.length !== existing.length) {
      this.routerGroups.set(routerNetwork, activeRouters);
    }
    return activeRouters;
  }

  private getPrimaryRoomRouterOrThrow(routerNetwork: string, context: string) {
    const routerGroup = this.getRoomRoutersOrThrow(routerNetwork, context);
    return routerGroup[0];
  }

  private getRoomRouterByIdOrThrow(
    routerNetwork: string,
    routerId: string,
    context: string,
  ) {
    const router = this.getRoomRoutersOrThrow(routerNetwork, context).find(
      (entry) => entry.id === routerId,
    );
    if (!router) {
      throw new Error(
        `Cannot locate router ${routerId} for ${routerNetwork} when ${context}`,
      );
    }
    return router;
  }

  private getWebRtcServerForRouterOrThrow(
    router: Router,
    context: string,
    routerNetwork: string,
  ) {
    const workerIndex = this.getRouterWorkerIndexOrThrow(
      router,
      context,
      routerNetwork,
    );
    const webRtcServer = this.webRtcServers[workerIndex];
    if (!webRtcServer) {
      throw new Error(
        `Cannot locate WebRTC server for worker ${workerIndex} when ${context} (${routerNetwork})`,
      );
    }
    return webRtcServer;
  }

  private countAssignedRoomsPerWorker() {
    const counts = new Array<number>(this.workers.length).fill(0);
    for (const roomRouters of this.routerGroups.values()) {
      const roomWorkers = new Set<number>();
      for (const router of roomRouters) {
        if (router.closed) {
          continue;
        }
        const workerIndex = this.resolveRouterWorkerIndex(router);
        if (
          workerIndex !== undefined &&
          workerIndex >= 0 &&
          workerIndex < counts.length
        ) {
          roomWorkers.add(workerIndex);
        }
      }
      for (const workerIndex of roomWorkers.values()) {
        counts[workerIndex] += 1;
      }
    }
    return counts;
  }

  private async chooseWorkerIndexForRoom(options?: {
    excludeWorkerIndexes?: Set<number>;
  }) {
    if (!this.workers.length) {
      throw new Error("Cannot choose worker; no workers initialized");
    }
    const excluded = options?.excludeWorkerIndexes ?? new Set<number>();
    const roomCounts = this.countAssignedRoomsPerWorker();
    const snapshots = await Promise.all(
      this.workers.map(async (worker, workerIndex) => {
        if (excluded.has(workerIndex)) {
          return undefined;
        }
        if (!worker || worker.closed) {
          return undefined;
        }
        const usage = await worker.getResourceUsage();
        return {
          workerIndex,
          cpuUsageTotal: extractWorkerCpuUsageTotal(usage),
          assignedRooms: roomCounts[workerIndex] ?? 0,
        } satisfies WorkerLoadSnapshot;
      }),
    );
    const availableSnapshots = snapshots.filter(
      (snapshot): snapshot is WorkerLoadSnapshot => snapshot !== undefined,
    );
    if (!availableSnapshots.length) {
      throw new Error("Cannot choose worker; all workers are closed");
    }
    return chooseLeastLoadedWorkerIndex(availableSnapshots);
  }

  private countRoomTransportsByRouter(routerNetwork: string) {
    const transportCounts = new Map<string, number>();
    for (const [transportId, roomName] of this.transportRoomNames.entries()) {
      if (roomName !== routerNetwork) {
        continue;
      }
      const transport = this.transports.get(transportId);
      if (!transport || transport.closed) {
        continue;
      }
      const routerId = this.transportRouterIds.get(transportId);
      if (!routerId) {
        continue;
      }
      transportCounts.set(routerId, (transportCounts.get(routerId) ?? 0) + 1);
    }
    return transportCounts;
  }

  private async maybeExpandRoomRouters(
    routerNetwork: string,
    context: string,
  ): Promise<Router[]> {
    const routerGroup = this.getRoomRoutersOrThrow(routerNetwork, context);
    if (routerGroup.length >= this.workers.length) {
      return routerGroup;
    }

    const transportCounts = this.countRoomTransportsByRouter(routerNetwork);
    const hasUnusedRoomRouter = routerGroup.some(
      (router) => (transportCounts.get(router.id) ?? 0) === 0,
    );
    if (hasUnusedRoomRouter) {
      return routerGroup;
    }

    const occupiedWorkers = new Set<number>();
    for (const router of routerGroup) {
      const workerIndex = this.resolveRouterWorkerIndex(router);
      if (workerIndex !== undefined) {
        occupiedWorkers.add(workerIndex);
      }
    }
    const workerIndex = await this.chooseWorkerIndexForRoom({
      excludeWorkerIndexes: occupiedWorkers,
    });
    const selectedWorker = this.workers[workerIndex];
    if (!selectedWorker || selectedWorker.closed) {
      throw new Error(
        `Cannot expand router group for ${routerNetwork}; worker ${workerIndex} is unavailable`,
      );
    }
    const router = await selectedWorker.createRouter({
      mediaCodecs: this.mediaCodecs,
      appData: { workerIndex } as AppData,
    });
    routerGroup.push(router);
    this.routerGroups.set(routerNetwork, routerGroup);
    return routerGroup;
  }

  private async chooseRoomRouterForNewTransport(
    routerNetwork: string,
    context: string,
  ) {
    const routerGroup = await this.maybeExpandRoomRouters(
      routerNetwork,
      context,
    );
    if (!routerGroup.length) {
      throw new Error(
        `Cannot choose router for ${routerNetwork} when ${context}; room has no routers`,
      );
    }
    const transportCounts = this.countRoomTransportsByRouter(routerNetwork);
    const leastLoaded = new Array<Router>();
    let minCount = Number.POSITIVE_INFINITY;
    for (const router of routerGroup) {
      const count = transportCounts.get(router.id) ?? 0;
      if (count < minCount) {
        minCount = count;
        leastLoaded.length = 0;
        leastLoaded.push(router);
      } else if (count === minCount) {
        leastLoaded.push(router);
      }
    }
    if (!leastLoaded.length) {
      throw new Error(
        `Cannot choose router for ${routerNetwork} when ${context}; no least-loaded candidate was produced`,
      );
    }
    if (leastLoaded.length === 1) {
      return leastLoaded[0];
    }
    let selectedRouter = leastLoaded[0];
    let selectedWorkerIndex = this.getRouterWorkerIndexOrThrow(
      selectedRouter,
      context,
      routerNetwork,
    );
    for (let i = 1; i < leastLoaded.length; i++) {
      const candidateRouter = leastLoaded[i];
      const candidateWorkerIndex = this.getRouterWorkerIndexOrThrow(
        candidateRouter,
        context,
        routerNetwork,
      );
      if (candidateWorkerIndex > selectedWorkerIndex) {
        selectedRouter = candidateRouter;
        selectedWorkerIndex = candidateWorkerIndex;
        continue;
      }
      if (
        candidateWorkerIndex === selectedWorkerIndex &&
        candidateRouter.id > selectedRouter.id
      ) {
        selectedRouter = candidateRouter;
        selectedWorkerIndex = candidateWorkerIndex;
      }
    }
    return selectedRouter;
  }

  private getTransportOrThrow(transportId: string, context: string) {
    const transport = this.transports.get(transportId);
    if (!transport) {
      throw new Error(`Cannot locate transport ${transportId} when ${context}`);
    }
    return transport;
  }

  private getPipeTransportOrThrow(
    routerNetwork: string,
    remoteServerId: string,
    context: string,
  ) {
    const key = this.buildPipeTransportKey(routerNetwork, remoteServerId);
    const pipeTransport = this.networkPipeTransports.get(key);
    if (!pipeTransport) {
      throw new Error(
        `Cannot locate network pipe transport for ${routerNetwork} (${remoteServerId}) when ${context}`,
      );
    }
    return pipeTransport;
  }

  private getPipeTransportRouterOrThrow(
    routerNetwork: string,
    remoteServerId: string,
    context: string,
  ) {
    const key = this.buildPipeTransportKey(routerNetwork, remoteServerId);
    const routerId = this.networkPipeTransportRouterIds.get(key);
    if (!routerId) {
      throw new Error(
        `Cannot locate router mapping for network pipe transport ${routerNetwork} (${remoteServerId}) when ${context}`,
      );
    }
    return routerId;
  }

  private getPipeTransportsForRoom(routerNetwork: string) {
    const prefix = this.buildPipeTransportKey(routerNetwork, "");
    return Array.from(this.networkPipeTransports.entries())
      .filter(([key]) => key.startsWith(prefix))
      .map(([, transport]) => transport);
  }

  private buildPipeTransportKey(routerNetwork: string, remoteServerId: string) {
    return buildPipeTransportKey(routerNetwork, remoteServerId);
  }

  private buildConsumerRelayKey(transportId: string, producerId: string) {
    return `${transportId}:${producerId}`;
  }

  private getTrackedConsumer(transportId: string, producerId: string) {
    const key = this.buildConsumerRelayKey(transportId, producerId);
    const consumerId = this.consumerIndexByTransportProducer.get(key);
    if (!consumerId) {
      return undefined;
    }
    const consumer = this.consumers.get(consumerId);
    if (!consumer || consumer.closed) {
      this.consumerIndexByTransportProducer.delete(key);
      if (consumerId) {
        this.consumers.delete(consumerId);
      }
      return undefined;
    }
    return consumer;
  }

  private trackConsumer(
    transportId: string,
    producerId: string,
    consumer: Consumer,
  ) {
    const key = this.buildConsumerRelayKey(transportId, producerId);
    const existingConsumerId = this.consumerIndexByTransportProducer.get(key);
    if (existingConsumerId && existingConsumerId !== consumer.id) {
      const existingConsumer = this.consumers.get(existingConsumerId);
      if (existingConsumer && !existingConsumer.closed) {
        existingConsumer.close();
      }
      this.consumers.delete(existingConsumerId);
    }
    this.consumerIndexByTransportProducer.set(key, consumer.id);
    this.consumers.set(consumer.id, consumer);
    let closed = false;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      this.consumers.delete(consumer.id);
      if (this.consumerIndexByTransportProducer.get(key) === consumer.id) {
        this.consumerIndexByTransportProducer.delete(key);
      }
    };
    consumer.on("@close", cleanup);
    consumer.on("producerclose", cleanup);
    consumer.on("transportclose", cleanup);
  }

  private cleanupProducerRouting(producerId: string) {
    this.producerRouterIds.delete(producerId);
    this.producerRoomNames.delete(producerId);
    this.localPipedProducerTargets.delete(producerId);
  }

  private async ensureProducerVisibleOnRouter(
    producerId: string,
    targetRouter: Router,
    context: string,
  ) {
    const sourceRoom = this.producerRoomNames.get(producerId);
    const sourceRouterId = this.producerRouterIds.get(producerId);
    if (!sourceRoom || !sourceRouterId) {
      throw new Error(
        `Missing producer routing for ${producerId} when ${context}`,
      );
    }
    if (sourceRouterId === targetRouter.id) {
      return;
    }
    const pipedTargets = this.localPipedProducerTargets.get(producerId);
    if (pipedTargets?.has(targetRouter.id)) {
      return;
    }
    const sourceRouter = this.getRoomRouterByIdOrThrow(
      sourceRoom,
      sourceRouterId,
      context,
    );
    const result = await sourceRouter.pipeToRouter({
      producerId,
      router: targetRouter,
    });
    if (!result.pipeProducer) {
      throw new Error(
        `Failed to pipe producer ${producerId} into router ${targetRouter.id} for ${context}`,
      );
    }
    const targets = pipedTargets ?? new Set<string>();
    targets.add(targetRouter.id);
    this.localPipedProducerTargets.set(producerId, targets);
  }

  private async ensureProducerVisibleOnTransportRouter(
    producerId: string,
    transportId: string,
    context: string,
  ) {
    const roomName = this.transportRoomNames.get(transportId);
    const routerId = this.transportRouterIds.get(transportId);
    if (!roomName || !routerId) {
      throw new Error(
        `Missing transport routing metadata for transport ${transportId} when ${context}`,
      );
    }
    const targetRouter = this.getRoomRouterByIdOrThrow(
      roomName,
      routerId,
      context,
    );
    await this.ensureProducerVisibleOnRouter(producerId, targetRouter, context);
  }

  private async getOrCreateNetworkPipeTransport(
    routerNetwork: string,
    remoteServerId: string,
    appData: AppData | undefined,
    context: string,
  ) {
    const router = this.getPrimaryRoomRouterOrThrow(routerNetwork, context);
    const key = this.buildPipeTransportKey(routerNetwork, remoteServerId);
    let pipeRelay = this.networkPipeTransports.get(key);
    let created = false;
    if (!pipeRelay) {
      pipeRelay = await router.createPipeTransport({
        listenInfo: {
          protocol: "udp",
          ip: "0.0.0.0",
        },
        appData: appData,
      });
      created = true;
      pipeRelay.on("routerclose", () => {
        console.log("Network pipe transport closed.");
        this.networkPipeTransports.delete(key);
        this.networkPipeTransportRouterIds.delete(key);
      });
      this.networkPipeTransports.set(key, pipeRelay);
      this.networkPipeTransportRouterIds.set(key, router.id);
    } else if (!this.networkPipeTransportRouterIds.has(key)) {
      this.networkPipeTransportRouterIds.set(key, router.id);
    }
    return { pipeRelay, created };
  }

  private trackWebRtcTransport(
    transport: WebRtcTransport,
    routerNetwork: string,
    routerId: string,
    direction: "ingress" | "egress",
  ) {
    this.transportRoomNames.set(transport.id, routerNetwork);
    this.transportRouterIds.set(transport.id, routerId);
    let closed = false;
    const handleClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      this.transports.delete(transport.id);
      this.transportRoomNames.delete(transport.id);
      this.transportRouterIds.delete(transport.id);
      this.onTransportClosed?.(transport.id, direction);
    };
    transport.on("@close", handleClose);
    transport.on("routerclose", handleClose);
    transport.on("listenserverclose", handleClose);
  }

  // Router groups -----------------------------------------------------------

  // Create network of routers connected by local pipe transports for a router network
  async createRouterGroup(routerNetwork: string) {
    let routerGroup = this.routerGroups.get(routerNetwork);
    if (routerGroup) {
      routerGroup = routerGroup.filter((router) => !router.closed);
      if (routerGroup.length) {
        this.routerGroups.set(routerNetwork, routerGroup);
        return routerGroup[0].rtpCapabilities;
      }
    } else {
      routerGroup = new Array<Router>();
    }

    console.log(`Creating router group for router network ${routerNetwork}`);
    const workerIndex = await this.chooseWorkerIndexForRoom();
    const selectedWorker = this.workers[workerIndex];
    if (!selectedWorker || selectedWorker.closed) {
      throw new Error(
        `Cannot create router for ${routerNetwork}; worker ${workerIndex} is unavailable`,
      );
    }
    const router = await selectedWorker.createRouter({
      mediaCodecs: this.mediaCodecs,
      appData: { workerIndex } as AppData,
    });
    console.log("Router created", router.id);

    routerGroup.push(router);
    this.routerGroups.set(routerNetwork, routerGroup);

    return router.rtpCapabilities;
  }

  // Destroy network of routers connected by local pipe transports for a router network
  async destroyRouterGroup(routerNetwork: string) {
    let routerGroup = this.routerGroups.get(routerNetwork);

    if (!routerGroup) {
      return;
    }

    routerGroup.forEach((router) => {
      router.close();
    });
    this.routerGroups.delete(routerNetwork);
    for (const [transportId, roomName] of this.transportRoomNames.entries()) {
      if (roomName !== routerNetwork) {
        continue;
      }
      this.transportRoomNames.delete(transportId);
      this.transportRouterIds.delete(transportId);
    }
    for (const [producerId, roomName] of this.producerRoomNames.entries()) {
      if (roomName === routerNetwork) {
        this.cleanupProducerRouting(producerId);
      }
    }

    //Clean up network pipe transports
    // We could do this earlier when the peer deletes the webrtc transport
    const pipeTransports = this.getPipeTransportsForRoom(routerNetwork);
    for (const transport of pipeTransports) {
      if (!transport.closed) {
        console.warn("Network Pipe Transport is still open... closing...");
        transport.close();
      }
    }
    const prefix = this.buildPipeTransportKey(routerNetwork, "");
    for (const [key] of this.networkPipeTransports.entries()) {
      if (key.startsWith(prefix)) {
        this.networkPipeTransports.delete(key);
        this.networkPipeTransportRouterIds.delete(key);
      }
    }
    //Do we need to close pipe transports? Networkpipe transports?
  }

  async dumpRouterGroup(
    routerNetwork: string,
    onWarning?: (warning: RouterDumpWarning) => void,
  ): Promise<RouterGroupDump> {
    const routerGroup = this.getRoomRoutersOrThrow(
      routerNetwork,
      "dumpRouterGroup",
    );
    const routers = await Promise.all(
      routerGroup.map((router) => router.dump()),
    );
    const pipeRelays = this.getPipeTransportsForRoom(routerNetwork);
    const pipeTransports = await Promise.all(
      pipeRelays.filter((pipe) => !pipe.closed).map((pipe) => pipe.dump()),
    );
    const stats = await collectRouterDumpStats({
      routers,
      pipeRelays,
      webrtcTransports: this.transports,
      onWarning,
    });

    return {
      routers: stats.routers,
      pipeTransports,
      webrtcTransportStats: stats.webrtcTransportStats,
      pipeTransportStats: stats.pipeTransportStats,
    };
  }

  // WebRTC transports -------------------------------------------------------

  // Create listening and receiving endpoint for browser client to connect and send to
  async createWebRTCIngressTransport(
    routerNetwork: string,
    numSctpStreams: NumSctpStreams,
  ) {
    const router = await this.chooseRoomRouterForNewTransport(
      routerNetwork,
      "createWebRTCIngressTransport",
    );
    const webRtcServer = this.getWebRtcServerForRouterOrThrow(
      router,
      "createWebRTCIngressTransport",
      routerNetwork,
    );
    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: true,
      enableTcp: false,
      preferUdp: true,
      preferTcp: false,
      numSctpStreams: numSctpStreams,
    });

    this.transports.set(transport.id, transport);
    this.trackWebRtcTransport(transport, routerNetwork, router.id, "ingress");

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  // Create listening and sending endpoint for browser client to connect and receive from
  async createWebRTCEgressTransport(
    routerNetwork: string,
    numSctpStreams?: NumSctpStreams,
  ) {
    const router = await this.chooseRoomRouterForNewTransport(
      routerNetwork,
      "createWebRTCEgressTransport",
    );
    const webRtcServer = this.getWebRtcServerForRouterOrThrow(
      router,
      "createWebRTCEgressTransport",
      routerNetwork,
    );
    const transport = await router.createWebRtcTransport({
      webRtcServer,
      enableUdp: true,
      enableTcp: false,
      preferUdp: true,
      preferTcp: false,
      numSctpStreams: numSctpStreams,
    });

    this.transports.set(transport.id, transport);
    this.trackWebRtcTransport(transport, routerNetwork, router.id, "egress");

    return {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };
  }

  // WebRTC transport connections -------------------------------------------

  // Connect WebRTC ingress transport
  async connectWebRTCIngressTransport(
    transportId: string,
    dtlsParameters: DtlsParameters,
  ) {
    const selectedTransport = this.getTransportOrThrow(
      transportId,
      "connectWebRTCIngressTransport",
    );
    await selectedTransport.connect({
      dtlsParameters: dtlsParameters,
    });
  }

  // Connect WebRTC Egress transport
  async connectWebRTCEgressTransport(
    transportId: string,
    dtlsParameters: DtlsParameters,
  ) {
    const selectedTransport = this.getTransportOrThrow(
      transportId,
      "connectWebRTCEgressTransport",
    );

    await selectedTransport.connect({
      dtlsParameters: dtlsParameters,
    });
  }

  // Disconnect WebRTC transport
  async disconnectWebRTCTransport(transportId: string) {
    const selectedTransport = this.transports.get(transportId);
    if (!selectedTransport) {
      console.debug(`Transport already closed ${transportId}`);
      return;
    }
    selectedTransport.close();
  }

  // Producers ---------------------------------------------------------------

  async createMediaProducer(
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
    appData?: AppData,
  ) {
    // Lookup transport to create producer on
    const transport = this.getTransportOrThrow(
      transportId,
      "createMediaProducer",
    );

    const producer = await transport.produce({
      kind: kind,
      rtpParameters: rtpParameters,
      appData: appData,
    });
    const routerNetwork = this.transportRoomNames.get(transportId);
    const routerId = this.transportRouterIds.get(transportId);
    if (routerNetwork && routerId) {
      this.producerRoomNames.set(producer.id, routerNetwork);
      this.producerRouterIds.set(producer.id, routerId);
    }
    let closed = false;
    const handleClose = () => {
      if (closed) {
        return;
      }
      closed = true;
      this.producers.delete(producer.id);
      this.cleanupProducerRouting(producer.id);
      this.onProducerClosed?.(producer.id, producer.kind, producer.appData);
    };
    producer.on("@close", handleClose);
    producer.on("transportclose", handleClose);
    this.producers.set(producer.id, producer);

    return {
      id: producer.id,
      kind: producer.kind,
      rtpParameters: producer.rtpParameters,
      appData: producer.appData,
    };
  }

  async closeProducer(producerId: string) {
    const producer = this.producers.get(producerId);
    if (!producer) {
      console.debug(`Producer already closed ${producerId}`);
      return;
    }
    producer.close();
  }

  /**
   * Applies pause/resume state to one producer.
   *
   * @param producerId - Producer id.
   * @param paused - `true` to pause, `false` to resume.
   * @returns `void`.
   * @throws {Error} When producer is missing.
   */
  setProducerPaused(producerId: string, paused: boolean) {
    const producer = this.producers.get(producerId);
    if (!producer) {
      throw new Error(`Missing producer ${producerId} on setProducerPaused`);
    }
    if (paused) {
      producer.pause();
    } else {
      producer.resume();
    }
  }

  // Pipe transports ---------------------------------------------------------

  async createNetworkPipeTransportIngress(
    routerNetwork: string,
    remoteEgressId: string,
    appData?: AppData,
  ) {
    return createNetworkPipeTransportIngressRelay({
      routerNetwork,
      remoteEgressId,
      appData,
      getOrCreateNetworkPipeTransport:
        this.getOrCreateNetworkPipeTransport.bind(this),
    });
  }

  async consumeNetworkPipeTransport(
    routerNetwork: string,
    producerId: string,
    remoteEgressId: string,
    appData?: AppData,
  ) {
    return consumeNetworkPipeTransportRelay({
      routerNetwork,
      producerId,
      remoteEgressId,
      appData,
      getPipeTransportRouterOrThrow:
        this.getPipeTransportRouterOrThrow.bind(this),
      getRoomRouterByIdOrThrow: this.getRoomRouterByIdOrThrow.bind(this),
      ensureProducerVisibleOnRouter:
        this.ensureProducerVisibleOnRouter.bind(this),
      getPipeTransportOrThrow: this.getPipeTransportOrThrow.bind(this),
    });
  }

  async createNetworkPipeTransportEgress(
    shouldConnectPipeTransport: boolean,
    routerNetwork: string,
    remoteIngressId: string,
    ingressIp: string,
    ingressPort: number,
    appData: AppData,
  ) {
    return createNetworkPipeTransportEgressRelay({
      shouldConnectPipeTransport,
      routerNetwork,
      remoteIngressId,
      ingressIp,
      ingressPort,
      appData,
      getOrCreateNetworkPipeTransport:
        this.getOrCreateNetworkPipeTransport.bind(this),
      networkPipeTransports: this.networkPipeTransports,
      networkPipeTransportRouterIds: this.networkPipeTransportRouterIds,
    });
  }

  async produceNetworkPipeTransport(
    routerNetwork: string,
    producerId: string,
    remoteIngressId: string,
    consumerOptions: {
      kind: MediaKind;
      rtpParameters: RtpParameters;
      appData?: AppData;
    },
  ) {
    return produceNetworkPipeTransportRelay({
      routerNetwork,
      producerId,
      remoteIngressId,
      consumerOptions,
      getPipeTransportOrThrow: this.getPipeTransportOrThrow.bind(this),
      getPipeTransportRouterOrThrow:
        this.getPipeTransportRouterOrThrow.bind(this),
      pipeProducers: this.pipeProducers,
      producerRoomNames: this.producerRoomNames,
      producerRouterIds: this.producerRouterIds,
      cleanupProducerRouting: this.cleanupProducerRouting.bind(this),
    });
  }

  async closePipeProducer(producerId: string) {
    return closePipeProducerRelay({
      producerId,
      pipeProducers: this.pipeProducers,
    });
  }

  // Runs on ingress, so connect ingress network pipe transport to egress ip/port
  async finalizeNetworkPipeTransport(
    connectedTransport: boolean,
    routerNetwork: string,
    remoteEgressId: string,
    egressIp: string,
    egressPort: number,
  ) {
    return finalizeNetworkPipeTransportRelay({
      connectedTransport,
      routerNetwork,
      remoteEgressId,
      egressIp,
      egressPort,
      getPipeTransportOrThrow: this.getPipeTransportOrThrow.bind(this),
    });
  }

  // Runs on egress, so create consumers on the transports
  // Consumers ---------------------------------------------------------------

  async createEgressConsumer(
    producerSets: { [producerPeerId: string]: string[] }[],
    consumerTransports: string[],
    rtpCapabilities: RtpCapabilities,
  ) {
    const consumersCreated: MediaConsumers = new Object() as MediaConsumers;

    const producerEntries = new Array<{
      producerPeerId: string;
      producerId: string;
    }>();
    for (const producerSet of producerSets) {
      for (const [producerPeerId, producerIds] of Object.entries(producerSet)) {
        for (const producerId of producerIds) {
          producerEntries.push({ producerPeerId, producerId });
        }
      }
    }

    const resolvedConsumerTransports = new Array<{
      transportConsumerId: string;
      transport: WebRtcTransport;
    }>();
    for (const transportConsumerId of consumerTransports) {
      const transport = this.transports.get(transportConsumerId);
      if (!transport) {
        throw new Error(
          `Transport not found when creating consumer: ${transportConsumerId}`,
        );
      }
      resolvedConsumerTransports.push({ transportConsumerId, transport });
    }

    for (const { producerPeerId, producerId } of producerEntries) {
      for (const {
        transportConsumerId,
        transport,
      } of resolvedConsumerTransports) {
        await this.ensureProducerVisibleOnTransportRouter(
          producerId,
          transportConsumerId,
          "createEgressConsumer",
        );
        let consumer = this.getTrackedConsumer(transportConsumerId, producerId);
        if (!consumer) {
          consumer = await transport.consume({
            producerId,
            rtpCapabilities,
          });
          this.trackConsumer(transportConsumerId, producerId, consumer);
        }

        if (!consumersCreated[transportConsumerId]) {
          consumersCreated[transportConsumerId] = new Array<
            MediaConsumers[string][number]
          >();
        }

        consumersCreated[transportConsumerId].push({
          producerPeerId,
          id: consumer.id,
          producerId: consumer.producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          appData: consumer.appData,
        });
      }
    }
    return consumersCreated;
  }
}
