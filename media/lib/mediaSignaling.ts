// Media signaling (netsocket)
import type {
  NsRelayMessageMap,
  NsResponseMessageMap,
  NsServiceMessageMap,
  ResponseSignalWrapper,
  RequestSignalWrapper,
  CreateRouterGroup as MediaCreateRouterGroupMessage,
  DestroyRouterGroup as MediaDestroyRouterGroupMessage,
  CreateWebRTCIngressTransport as MediaCreateWebRTCIngressMessage,
  CreateWebRTCEgressTransport as MediaCreateWebRTCEgressMessage,
  ConnectWebRTCTransport as MediaConnectWebRTCMessage,
  CreateMediaProducer as MediaCreateMediaProducerMessage,
  ConnectNetworkRelay as MediaConnectNetworkRelayMessage,
  FinalizeNetworkRelay as MediaFinalizeNetworkRelayMessage,
  CreateMediaConsumer as MediaCreateMediaConsumerMessage,
  ProducerClose as MediaProducerCloseMessage,
  SetProducerPaused as MediaSetProducerPausedMessage,
  DumpRouterGroup as MediaDumpRouterGroupMessage,
  TeardownPeerSession as MediaTeardownPeerSessionMessage,
  MediaDiagnostic as MediaDiagnosticMessage,
} from "../../types/nsRelay.d.ts";
import {
  buildConnectedNetworkRelayMessage,
  buildConnectedWebRTCTransportMessage,
  buildCreatedConsumerMessage,
  buildCreatedMediaProducerMessage,
  buildCreatedRouterGroupMessage,
  buildCreatedWebRTCTransportMessage,
  buildDisconnectedWebRTCTransportMessage,
  buildFinalizedNetworkRelayMessage,
  buildInitializedNetworkRelayMessage,
  buildMediaDiagnosticMessage,
  buildRegisterMediaServerMessage,
  buildRelayPayload,
  buildResponsePayload,
  buildRouterDumpMessage,
  buildServerLoadMessage,
  buildServicePayload,
  buildUnregisterMediaServerMessage,
  buildProducerClosedMessage as buildMediaProducerClosedMessage,
} from "./protocol/messageBuilders.js";
import type {
  PipeTransportDump,
  RouterDump,
  StatTotals,
} from "./sfuDumpStats.js";
import type { SFU as SFUClass } from "./sfuCore.ts";
import { randomUUID } from "crypto";
import PQueue from "p-queue";
import * as net from "net";
import * as os from "os";
import type { Transform } from "stream";
import lps from "length-prefixed-stream";

const resolveRegion = () => process.env.REGION || "local";
const DEFAULT_MEDIA_SIGNALING_QUEUE_LIMIT = 1024;

const resolveQueueLimit = (value: string | undefined) => {
  if (!value || value.trim().length === 0) {
    return DEFAULT_MEDIA_SIGNALING_QUEUE_LIMIT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid MEDIA_SIGNALING_QUEUE_LIMIT value '${value}'. Expected a positive integer.`,
    );
  }
  return parsed;
};

/**
 * Media-node netsocket control-plane adapter.
 *
 * This class owns registration with signaling, inbound command dispatch,
 * and outbound response/event emission for both ingress and egress media nodes.
 */
export class MediaSignaling {
  registrationId: string;
  clientSocket: net.Socket;
  encoder: Transform | undefined;
  sfu: SFUClass;
  instructionQueue: PQueue;
  remotePort: number | undefined;
  remoteHost: string | undefined;
  loadInterval: NodeJS.Timeout | undefined;
  cpuSamples: { idle: number; total: number }[];
  producerOrigins: Map<string, { originId: string; mediaType: string }>;
  transportOrigins: Map<
    string,
    { originId: string; direction: "ingress" | "egress" }
  >;
  instructionQueueLimit: number;
  private fatalExitScheduled: boolean;
  private shutdownInitiated: boolean;

  constructor(sfu: SFUClass) {
    this.sfu = sfu;
    this.sfu.onProducerClosed = (producerId, kind) => {
      this.handleProducerClosed(producerId, kind);
    };
    this.sfu.onTransportClosed = (transportId, direction) => {
      this.handleTransportClosed(transportId, direction);
    };
    this.clientSocket = new net.Socket(); //This instance is sacrificed on connect...
    this.encoder = undefined;

    this.instructionQueue = new PQueue({ concurrency: 1 });
    this.registrationId = randomUUID();
    this.loadInterval = undefined;
    this.cpuSamples = new Array<{ idle: number; total: number }>();
    this.producerOrigins = new Map();
    this.transportOrigins = new Map();
    this.instructionQueueLimit = resolveQueueLimit(
      process.env.MEDIA_SIGNALING_QUEUE_LIMIT,
    );
    this.fatalExitScheduled = false;
    this.shutdownInitiated = false;
    console.log(
      "Starting signaling for",
      this.sfu.mode,
      "media server",
      this.registrationId,
      "in",
      resolveRegion(),
      "...",
    );
  }

  // Connection lifecycle ----------------------------------------------------

  /**
   * Establishes netsocket connection to signaling and bootstraps media registration.
   *
   * @param port - Signaling netsocket port.
   * @param host - Signaling host.
   * @returns `void`.
   */
  connect(port: number, host: string) {
    this.remotePort = port;
    this.remoteHost = host;

    // Start netsocket connection to signaling server
    this.clientSocket = new net.Socket();
    const decoder: Transform = lps.decode();
    const encoder: Transform = lps.encode();
    this.encoder = encoder;
    this.clientSocket.pipe(decoder);
    encoder.pipe(this.clientSocket);

    decoder.on("error", (error: Error) => {
      this.handleFatalError("Signaling relay decode error", error);
    });

    encoder.on("error", (error: Error) => {
      this.handleFatalError("Signaling relay encode error", error);
    });

    this.clientSocket.on("end", () => {
      // Don't reconnect on end, because close will still trigger.
      console.log("Signaling relay connection ended.");
    });

    this.clientSocket.on("error", (error: Error) => {
      this.handleFatalError("Signaling relay connection error", error, false);
    });

    this.clientSocket.on("close", async () => {
      if (this.shutdownInitiated) {
        console.log("Signaling relay connection closed during shutdown.");
        return;
      }
      console.error("Signaling relay connection closed.");
      await this.clearState({ destroySocket: false, resetSfu: true });
      this.scheduleFatalExit();
    });

    // Receiving messages over netsocket
    decoder.on("data", (buffer: Buffer) => {
      void this.handleIncomingBuffer(buffer);
    });

    this.clientSocket.on("ready", () => {
      // Register with the signaling server
      this.sendServiceMessage(
        "registerMediaServer",
        buildRegisterMediaServerMessage(
          this.registrationId,
          this.sfu.mode,
          resolveRegion(),
        ),
      );
      this.startLoadReporting();
    });

    //Connect the socket
    this.clientSocket.connect(port, host, () => {
      console.log("Connected to signaling server");
    });
  }

  /** Reset all values and act like a brand new server when connecting */
  async clearState(options?: { destroySocket?: boolean; resetSfu?: boolean }) {
    const destroySocket = options?.destroySocket ?? true;
    const resetSfu = options?.resetSfu ?? true;
    if (destroySocket) {
      this.clientSocket.destroy();
    }
    try {
      if (resetSfu) {
        await this.sfu.reset();
      }
    } finally {
      this.encoder = undefined;
      this.instructionQueue.clear();
      this.producerOrigins.clear();
      this.transportOrigins.clear();
      this.stopLoadReporting();
    }
  }

  async shutdown(reason = "server_shutdown", detail?: string) {
    if (this.shutdownInitiated) {
      return;
    }
    this.shutdownInitiated = true;
    this.instructionQueue.clear();
    this.producerOrigins.clear();
    this.transportOrigins.clear();
    this.stopLoadReporting();
    this.sendServiceMessage(
      "unregisterMediaServer",
      buildUnregisterMediaServerMessage({
        mode: this.sfu.mode,
        region: resolveRegion(),
        reason,
        detail,
      }),
    );

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      };

      const timeout = setTimeout(() => {
        this.clientSocket.destroy();
        finish();
      }, 500);
      if (typeof timeout.unref === "function") {
        timeout.unref();
      }

      try {
        this.clientSocket.end(() => {
          clearTimeout(timeout);
          finish();
        });
      } catch (err) {
        console.warn(
          "Failed to end signaling relay socket cleanly during shutdown",
          err,
        );
        clearTimeout(timeout);
        finish();
      }
    });
  }

  private startLoadReporting() {
    if (this.loadInterval) return;
    this.loadInterval = setInterval(async () => {
      try {
        const cpus = os.cpus();
        if (!cpus.length) {
          const details =
            "Failed to send server load: no CPU samples available";
          console.warn(details);
          this.sendMediaDiagnostic({
            severity: "warn",
            category: "mediaServerLifecycle",
            message: "media server load report skipped",
            details,
            context: {
              mode: this.sfu.mode,
            },
          });
          return;
        }
        const perCpuPercents = new Array<number>();
        cpus.forEach((cpu, idx) => {
          const total =
            cpu.times.user +
            cpu.times.nice +
            cpu.times.sys +
            cpu.times.idle +
            cpu.times.irq;
          const idle = cpu.times.idle;
          const prev = this.cpuSamples[idx] || { idle, total };
          const deltaTotal = total - prev.total;
          const deltaIdle = idle - prev.idle;
          const percent =
            deltaTotal > 0
              ? Math.min(
                  100,
                  Math.max(
                    0,
                    Math.round(((deltaTotal - deltaIdle) / deltaTotal) * 1000) /
                      10,
                  ),
                )
              : 0;
          perCpuPercents.push(percent);
          this.cpuSamples[idx] = { idle, total };
        });

        const loadPercent =
          perCpuPercents.reduce((a, b) => a + b, 0) / perCpuPercents.length;

        this.sendServiceMessage(
          "serverLoad",
          buildServerLoadMessage({
            mode: this.sfu.mode,
            region: resolveRegion(),
            load: Math.round(loadPercent * 10) / 10,
            loadPerCpu: perCpuPercents,
          }),
        );
      } catch (err) {
        const details = err instanceof Error ? err.message : String(err);
        console.warn("Failed to send server load", err);
        this.sendMediaDiagnostic({
          severity: "warn",
          category: "mediaServerLifecycle",
          message: "media server load report failed",
          details,
          context: {
            mode: this.sfu.mode,
          },
        });
      }
    }, 5000);
    if (typeof this.loadInterval.unref === "function") {
      this.loadInterval.unref();
    }
  }

  private stopLoadReporting() {
    if (this.loadInterval) {
      clearInterval(this.loadInterval);
      this.loadInterval = undefined;
    }
  }

  private scheduleFatalExit() {
    if (this.shutdownInitiated || this.fatalExitScheduled) {
      return;
    }
    this.fatalExitScheduled = true;
    process.exitCode = 1;
    setImmediate(() => process.exit(1));
  }

  private handleFatalError(
    context: string,
    error: unknown,
    destroySocket = true,
  ) {
    if (this.shutdownInitiated) {
      return;
    }
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    console.error(context, normalized);
    if (destroySocket) {
      this.clientSocket.destroy(normalized);
    }
    this.scheduleFatalExit();
  }

  private async handleIncomingBuffer(buffer: Buffer) {
    let parsedMessage: RequestSignalWrapper;
    try {
      parsedMessage = JSON.parse(buffer.toString());
    } catch (err) {
      this.handleFatalError("Failed to parse incoming netsocket message", err);
      return;
    }

    if (!parsedMessage.payload) {
      this.handleFatalError(
        "Incoming netsocket message missing payload",
        new Error("Missing signal payload"),
      );
      return;
    }

    const queueDepth =
      this.instructionQueue.size + this.instructionQueue.pending;
    if (queueDepth >= this.instructionQueueLimit) {
      const details = `queueDepth=${queueDepth}, queueLimit=${this.instructionQueueLimit}, nextType=${parsedMessage.payload.type}`;
      this.sendMediaDiagnostic({
        severity: "error",
        category: "netsocketCommand",
        message: "media signaling queue overflow",
        details,
        context: {
          nextType: String(parsedMessage.payload.type),
        },
      });
      this.handleFatalError(
        "Media signaling inbound queue exceeded limit",
        new Error(details),
      );
      return;
    }

    try {
      await this.instructionQueue.add(async () => {
        await this.incomingNetsocketSignal(parsedMessage);
      });
    } catch (err) {
      this.handleFatalError(
        `Failed to execute incoming netsocket request type=${parsedMessage.payload.type}`,
        err,
      );
    }
  }

  // Outbound payload helpers -----------------------------------------------

  private sendPayload(payload: ResponseSignalWrapper["payload"]) {
    if (!this.encoder) {
      const missingEncoderError = new Error(
        "Cannot send netsocket payload: encoder unavailable",
      );
      if (this.shutdownInitiated) {
        console.warn(missingEncoderError.message);
        return;
      }
      this.handleFatalError(
        "Cannot send netsocket payload: encoder unavailable",
        missingEncoderError,
        false,
      );
      return;
    }
    const reply: ResponseSignalWrapper = {
      node: this.registrationId,
      payload,
    };
    try {
      const didBufferAcceptWrite = this.encoder.write(
        Buffer.from(JSON.stringify(reply)),
      );
      if (!didBufferAcceptWrite) {
        this.handleFatalError(
          "Failed to write netsocket payload: encoder backpressure",
          new Error("encoder backpressure"),
        );
      }
    } catch (error) {
      this.handleFatalError("Failed to write netsocket payload", error);
    }
  }

  private sendServiceMessage<T extends keyof NsServiceMessageMap>(
    type: T,
    message: NsServiceMessageMap[T],
  ) {
    this.sendPayload(buildServicePayload(type, message));
  }

  private sendResponseMessage<T extends keyof NsResponseMessageMap>(
    type: T,
    message: NsResponseMessageMap[T],
  ) {
    this.sendPayload(buildResponsePayload(type, message));
  }

  private sendMediaDiagnostic({
    severity,
    category,
    message,
    details,
    context,
  }: Omit<MediaDiagnosticMessage, "mode" | "region">) {
    if (this.shutdownInitiated) {
      return;
    }
    this.sendServiceMessage(
      "mediaDiagnostic",
      buildMediaDiagnosticMessage({
        mode: this.sfu.mode,
        region: resolveRegion(),
        severity,
        category,
        message,
        details,
        context,
      }),
    );
  }

  private sendRelayMessage<T extends keyof NsRelayMessageMap>(
    type: T,
    message: NsRelayMessageMap[T],
  ) {
    this.sendPayload(buildRelayPayload(type, message));
  }

  // Inbound netsocket handling ------------------------------------------------

  async incomingNetsocketSignal(signal: RequestSignalWrapper) {
    switch (signal.payload.type) {
      case "createRouterGroup":
        await this.createRouterGroup(signal.payload.message);
        break;
      case "destroyRouterGroup":
        await this.destroyRouterGroup(signal.payload.message);
        break;
      case "createWebRTCIngressTransport":
        await this.createWebRTCIngress(signal.payload.message);
        break;
      case "createWebRTCEgressTransport":
        await this.createWebRTCEgress(signal.payload.message);
        break;
      case "connectWebRTCIngressTransport":
        await this.connectWebRTCIngress(signal.payload.message);
        break;
      case "connectWebRTCEgressTransport":
        await this.connectWebRTCEgress(signal.payload.message);
        break;
      case "teardownPeerSession":
        await this.teardownPeerSession(signal.payload.message);
        break;
      case "createMediaProducer":
        await this.createMediaProducer(signal.payload.message);
        break;
      case "connectNetworkRelay":
        await this.connectNetworkRelay(signal.payload.message);
        break;
      case "finalizeNetworkRelay":
        await this.finalizeNetworkRelay(signal.payload.message);
        break;
      case "createConsumer":
        await this.createConsumer(signal.payload.message);
        break;
      case "producerClose":
        await this.closeProducer(signal.payload.message);
        break;
      case "setProducerPaused":
        this.setProducerPaused(signal.payload.message);
        break;
      case "dumpRouterGroup":
        await this.dumpRouterGroup(signal.payload.message);
        break;

      default:
        console.error("Unknown incoming netsocket request", signal);
        throw new Error(
          `Unknown incoming netsocket request type: ${String(signal.payload.type)}`,
        );
    }
  }

  // Router groups ------------------------------------------------------------

  async createRouterGroup(message: MediaCreateRouterGroupMessage) {
    const rtpCapabilities = await this.sfu.createRouterGroup(message.room);

    this.sendResponseMessage(
      "createdRouterGroup",
      buildCreatedRouterGroupMessage({
        room: message.room,
        roomRTPCapabilities: rtpCapabilities,
        serverId: this.registrationId,
        mode: this.sfu.mode,
        origin: message.origin,
      }),
    );
  }

  async destroyRouterGroup(message: MediaDestroyRouterGroupMessage) {
    await this.sfu.destroyRouterGroup(message.routerNetwork);
  }

  // WebRTC transports --------------------------------------------------------

  async createWebRTCIngress(message: MediaCreateWebRTCIngressMessage) {
    const transportOptions = await this.sfu.createWebRTCIngressTransport(
      message.routerNetwork,
      message.sctpOptions,
    );
    this.transportOrigins.set(transportOptions.id, {
      originId: message.originId,
      direction: "ingress",
    });

    this.sendResponseMessage(
      "createdWebRTCIngressTransport",
      buildCreatedWebRTCTransportMessage({
        originId: message.originId,
        transportId: transportOptions.id,
        iceParameters: transportOptions.iceParameters,
        iceCandidates: transportOptions.iceCandidates,
        dtlsParameters: transportOptions.dtlsParameters,
        sctpParameters: transportOptions.sctpParameters,
      }),
    );
  }

  async createWebRTCEgress(message: MediaCreateWebRTCEgressMessage) {
    const transportOptions = await this.sfu.createWebRTCEgressTransport(
      message.routerNetwork,
      message.sctpOptions,
    );
    this.transportOrigins.set(transportOptions.id, {
      originId: message.originId,
      direction: "egress",
    });

    this.sendResponseMessage(
      "createdWebRTCEgressTransport",
      buildCreatedWebRTCTransportMessage({
        originId: message.originId,
        transportId: transportOptions.id,
        iceParameters: transportOptions.iceParameters,
        iceCandidates: transportOptions.iceCandidates,
        dtlsParameters: transportOptions.dtlsParameters,
        sctpParameters: transportOptions.sctpParameters,
      }),
    );
  }

  // WebRTC transport connections ---------------------------------------------

  async connectWebRTCIngress(message: MediaConnectWebRTCMessage) {
    await this.sfu.connectWebRTCIngressTransport(
      message.transportId,
      message.dtlsParameters,
    );

    this.sendResponseMessage(
      "connectedWebRTCIngressTransport",
      buildConnectedWebRTCTransportMessage(message.originId),
    );
  }

  async connectWebRTCEgress(message: MediaConnectWebRTCMessage) {
    try {
      await this.sfu.connectWebRTCEgressTransport(
        message.transportId,
        message.dtlsParameters,
      );
    } catch (err) {
      console.error(
        "Failed to connect WebRTC egress transport",
        message.transportId,
        err,
      );
      throw err;
    }

    this.sendResponseMessage(
      "connectedWebRTCEgressTransport",
      buildConnectedWebRTCTransportMessage(message.originId),
    );
  }
  async teardownPeerSession(message: MediaTeardownPeerSessionMessage) {
    const transportIds = new Set<string>(message.transportIds);
    const producerIds = new Set<string>(message.producerIds);

    for (const [transportId, origin] of this.transportOrigins.entries()) {
      if (origin.originId === message.originId) {
        transportIds.add(transportId);
      }
    }
    for (const [producerId, origin] of this.producerOrigins.entries()) {
      if (origin.originId === message.originId) {
        producerIds.add(producerId);
      }
    }

    for (const transportId of transportIds) {
      try {
        await this.sfu.disconnectWebRTCTransport(transportId);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.sendMediaDiagnostic({
          severity: "warn",
          category: "transportLifecycle",
          message: "peer teardown failed to disconnect WebRTC transport",
          details: errorMessage,
          context: {
            originId: message.originId,
            peerId: message.peerId,
            operationId: message.operationId,
            transportId,
          },
        });
      }
    }

    for (const producerId of producerIds) {
      try {
        if (this.sfu.mode === "egress") {
          await this.sfu.closePipeProducer(producerId);
        } else {
          await this.sfu.closeProducer(producerId);
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.sendMediaDiagnostic({
          severity: "warn",
          category: "producerLifecycle",
          message: "peer teardown failed to close producer",
          details: errorMessage,
          context: {
            originId: message.originId,
            peerId: message.peerId,
            operationId: message.operationId,
            producerId,
          },
        });
      }
    }
  }

  // Producers ----------------------------------------------------------------

  async createMediaProducer(message: MediaCreateMediaProducerMessage) {
    const producer = await this.sfu.createMediaProducer(
      message.transportId,
      message.producerOptions.kind,
      message.producerOptions.rtpParameters,
      message.producerOptions.appData,
    );
    this.producerOrigins.set(producer.id, {
      originId: message.originId,
      mediaType: producer.kind,
    });

    //Also create network pipe transport
    // (This takes data from ingress, and delivers it to egress)
    const pipeTransport = await this.sfu.createNetworkPipeTransportIngress(
      message.routerNetwork,
      message.egress,
      message.producerOptions.appData,
    );

    //Also let the pipe transport consume the new producer
    // (This puts the actual data on the pipe transport so it can get to egress)
    const consumerOptions = await this.sfu.consumeNetworkPipeTransport(
      message.routerNetwork,
      producer.id,
      message.egress,
      message.producerOptions.appData,
    );

    // Include createNetworkPipeTransport so egress knows whether to create a relay transport.
    this.sendRelayMessage(
      "initializedNetworkRelay",
      buildInitializedNetworkRelayMessage({
        originId: message.originId,
        routerNetwork: message.routerNetwork,
        producerId: producer.id,
        consumerOptions: consumerOptions,
        createNetworkPipeTransport: pipeTransport.created,
        ingressIp: pipeTransport.ingressIp,
        ingressPort: pipeTransport.ingressPort,
        protocol: pipeTransport.protocol,
        appData: pipeTransport.appData,
        egressServer: message.egress, // This tells what egress to connect the pipe to.
      }),
    );

    //Send confirmation that a media producer has been created
    this.sendResponseMessage(
      "createdMediaProducer",
      buildCreatedMediaProducerMessage({
        originId: message.originId,
        producerId: producer.id,
        kind: producer.kind,
        rtpParameters: producer.rtpParameters,
        appData: producer.appData,
        requestId: message.requestId,
      }),
    );
  }

  async closeProducer(message: MediaProducerCloseMessage) {
    if (!message.producerId) {
      throw new Error(
        `Missing producerId on producerClose: ${JSON.stringify(message)}`,
      );
    }
    if (this.sfu.mode === "egress") {
      await this.sfu.closePipeProducer(message.producerId);
    } else {
      await this.sfu.closeProducer(message.producerId);
    }
  }

  /**
   * Applies pause/resume state for one producer requested by signaling.
   *
   * @param message - Producer pause command payload.
   * @returns `void`.
   */
  setProducerPaused(message: MediaSetProducerPausedMessage) {
    this.sfu.setProducerPaused(message.producerId, message.paused);
  }

  // Internal handlers --------------------------------------------------------

  /**
   * Handles local producer-close callback and forwards producerClosed response upstream.
   *
   * @param producerId - Closed producer id.
   * @param mediaType - Closed producer media type.
   * @returns `void`.
   */
  handleProducerClosed(producerId: string, mediaType: string) {
    const origin = this.producerOrigins.get(producerId);
    if (!origin) {
      console.debug(
        "Producer closed without origin mapping",
        producerId,
        mediaType,
      );
      return;
    }
    this.producerOrigins.delete(producerId);
    this.sendResponseMessage(
      "producerClosed",
      buildMediaProducerClosedMessage({
        originId: origin.originId,
        producerId,
        mediaType: mediaType ?? origin.mediaType,
      }),
    );
  }

  /**
   * Handles local transport-close callback and notifies signaling.
   *
   * @param transportId - Closed transport id.
   * @param direction - Closed transport direction.
   * @returns `void`.
   */
  handleTransportClosed(transportId: string, direction: "ingress" | "egress") {
    const origin = this.transportOrigins.get(transportId);
    if (origin) {
      this.transportOrigins.delete(transportId);
    } else {
      console.debug("Transport closed with unknown origin", transportId);
    }
    this.sendResponseMessage(
      "disconnectedWebRTCTransport",
      buildDisconnectedWebRTCTransportMessage({
        transportId,
        originId: origin?.originId,
        direction,
      }),
    );
  }

  // Network relays -----------------------------------------------------------

  // Ingress initiates a pipe transport.
  // Egress receives ingress ip/port, creates/connects a pipe transport,
  // consumes the relay, and returns the egress ip/port.
  async connectNetworkRelay(message: MediaConnectNetworkRelayMessage) {
    const egressNetworkPipeTransport =
      await this.sfu.createNetworkPipeTransportEgress(
        message.createNetworkPipeTransport,
        message.routerNetwork,
        message.ingressServer,
        message.ingressIp,
        message.ingressPort,
        message.appData,
      );

    await this.sfu.produceNetworkPipeTransport(
      message.routerNetwork,
      message.producerId,
      message.ingressServer,
      message.consumerOptions,
    );

    this.sendRelayMessage(
      "connectedNetworkRelay",
      buildConnectedNetworkRelayMessage({
        originId: message.originId,
        routerNetwork: message.routerNetwork,
        producerId: message.producerId,
        connectedTransport: egressNetworkPipeTransport.createdTransport,
        egressIp: egressNetworkPipeTransport.egressIp,
        egressPort: egressNetworkPipeTransport.egressPort,
        protocol: egressNetworkPipeTransport.protocol,
        appData: egressNetworkPipeTransport.appData,
        ingressServer: message.ingressServer,
      }),
    );
  }

  //Egress connected their pipe transport to ingress,
  // and gave the egress ip/port to connect to
  // Connect the ingress pipe transport to the egress ip/port
  // Don't bother consuming from egress, since this is ingress.
  async finalizeNetworkRelay(message: MediaFinalizeNetworkRelayMessage) {
    const producer = this.sfu.producers.get(message.producerId);
    if (!producer) {
      const failure = `Cannot finalize network relay; producer not found: ${message.producerId}`;
      console.error(failure, message);
      throw new Error(failure);
    }

    const ingressNetworkPipeTransport =
      await this.sfu.finalizeNetworkPipeTransport(
        message.connectedTransport,
        message.routerNetwork,
        message.egressServer,
        message.egressIp,
        message.egressPort,
      );

    this.sendRelayMessage(
      "finalizedNetworkRelay",
      buildFinalizedNetworkRelayMessage({
        originId: message.originId,
        producerId: message.producerId,
        routerNetwork: message.routerNetwork,
        kind: producer.kind,
        ingressIp: ingressNetworkPipeTransport.ingressIp,
        ingressPort: ingressNetworkPipeTransport.ingressPort,
        egressIp: ingressNetworkPipeTransport.egressIp,
        egressPort: ingressNetworkPipeTransport.egressPort,
        egressServer: message.egressServer,
      }),
    );
  }

  // Create X consumers getting data from the producer
  // and then send the consumer options back to signaling to send to client

  async createConsumer(message: MediaCreateMediaConsumerMessage) {
    //Get the transport of the peer... somehow
    // transportId is ID of webrtc transport
    let consumers = await this.sfu.createEgressConsumer(
      message.producerIds,
      message.consumerTransports,
      message.rtpCaps,
    );

    this.sendResponseMessage(
      "createdConsumer",
      buildCreatedConsumerMessage(consumers),
    );
  }

  async dumpRouterGroup(message: MediaDumpRouterGroupMessage) {
    let routers = new Array<RouterDump>();
    let pipeTransports = new Array<PipeTransportDump>();
    let webrtcTransportStats: Record<string, StatTotals> | undefined;
    let pipeTransportStats: Record<string, StatTotals> | undefined;
    let error: string | undefined;
    try {
      const dump = await this.sfu.dumpRouterGroup(message.room, (warning) => {
        const details =
          warning.error instanceof Error
            ? warning.error.message
            : String(warning.error);
        this.sendMediaDiagnostic({
          severity: "warn",
          category: "transportLifecycle",
          message: warning.message,
          details,
          context: {
            scope: warning.scope,
            transportId: warning.transportId,
          },
        });
      });
      routers = dump.routers as RouterDump[];
      pipeTransports = dump.pipeTransports as PipeTransportDump[];
      webrtcTransportStats = dump.webrtcTransportStats as
        | Record<string, StatTotals>
        | undefined;
      pipeTransportStats = dump.pipeTransportStats as
        | Record<string, StatTotals>
        | undefined;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      console.warn("Failed to dump router group", message.room, error);
      this.sendMediaDiagnostic({
        severity: "warn",
        category: "mediaServerLifecycle",
        message: "router dump failed",
        details: error,
        context: {
          room: message.room,
        },
      });
    }

    this.sendResponseMessage(
      "routerDump",
      buildRouterDumpMessage({
        origin: message.origin,
        room: message.room,
        serverId: this.registrationId,
        mode: this.sfu.mode,
        routers,
        pipeTransports,
        webrtcTransportStats,
        pipeTransportStats,
        error,
      }),
    );
  }
}
