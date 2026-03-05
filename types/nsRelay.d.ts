/*
 * Messages sent out and received to control media servers
 */

import type {
  ProducerOptions,
  RtpCapabilities,
  RtpParameters,
  SctpParameters,
  DtlsParameters,
  AppData,
  IceCandidate,
  IceParameters,
  NumSctpStreams,
} from "mediasoup/types";
import type {
  PipeTransportDumpEntry,
  RouterDumpEntry,
  TransportStats,
} from "./relayDumpTypes.d.ts";
export type {
  PipeTransportDumpEntry,
  RouterDumpEntry,
  TransportStats,
} from "./relayDumpTypes.d.ts";

// general types
export type Guid = string;

// Sending netsocket requests
export type BidirectionalSignalWrapper = {
  node: Guid;
  payload:
    | RequestPayload
    | ResponsePayload
    | NetworkRelayPayload
    | ServiceMessage;
};

export type RequestSignalWrapper = {
  node: Guid;
  payload: RequestPayload | NetworkRelayPayload;
};
export type ResponseSignalWrapper = {
  node: Guid;
  payload: ResponsePayload | NetworkRelayPayload | ServiceMessage;
};
// Sent messages to control media server
export type RequestPayload = { traceId?: Guid } & (
  | { type: "createRouterGroup"; message: CreateRouterGroup }
  | { type: "dumpRouterGroup"; message: DumpRouterGroup }
  | { type: "destroyRouterGroup"; message: DestroyRouterGroup }
  | {
      type: "createWebRTCIngressTransport";
      message: CreateWebRTCIngressTransport;
    }
  | {
      type: "createWebRTCEgressTransport";
      message: CreateWebRTCEgressTransport;
    }
  | { type: "connectWebRTCIngressTransport"; message: ConnectWebRTCTransport }
  | { type: "connectWebRTCEgressTransport"; message: ConnectWebRTCTransport }
  | { type: "createMediaProducer"; message: CreateMediaProducer }
  | { type: "consumeVideo"; message: ConsumeVideo }
  | { type: "consumeAudio"; message: ConsumeAudio }
  | { type: "producerClose"; message: ProducerClose }
  | { type: "setProducerPaused"; message: SetProducerPaused }
  | { type: "createConsumer"; message: CreateMediaConsumer }
  | { type: "teardownPeerSession"; message: TeardownPeerSession }
);

export type ResponsePayload = { traceId?: Guid } & (
  | { type: "createdRouterGroup"; message: CreatedRouterGroup }
  | { type: "routerDump"; message: RouterDump }
  | {
      type: "createdWebRTCIngressTransport";
      message: CreatedWebRTCIngressTransport;
    }
  | {
      type: "createdWebRTCEgressTransport";
      message: CreatedWebRTCEgressTransport;
    }
  | {
      type: "connectedWebRTCIngressTransport";
      message: ConnectedWebRTCTransport;
    }
  | {
      type: "connectedWebRTCEgressTransport";
      message: ConnectedWebRTCTransport;
    }
  | { type: "createdMediaProducer"; message: CreatedMediaProducer }
  | { type: "createdConsumer"; message: CreatedMediaConsumer }
  | { type: "producerClosed"; message: ProducerClosed }
  | {
      type: "disconnectedWebRTCTransport";
      message: DisconnectedWebRTCTransport;
    }
);

export type CreateWebRTCIngressTransport = {
  originId: Guid;
  sctpOptions: NumSctpStreams;
  routerNetwork: string;
};
export type CreatedWebRTCIngressTransport = {
  originId: Guid;
  transportId: Guid;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
};

export type CreateWebRTCEgressTransport = {
  originId: Guid;
  sctpOptions: NumSctpStreams;
  routerNetwork: string;
};
export type CreatedWebRTCEgressTransport = {
  originId: Guid;
  transportId: Guid;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
};

export type ConnectWebRTCTransport = {
  originId: Guid;
  transportId: Guid;
  dtlsParameters: DtlsParameters;
};
export type ConnectedWebRTCTransport = {
  originId: Guid;
};

export type CreateMediaProducer = {
  originId: Guid;
  transportId: Guid;
  producerOptions: ProducerOptions;
  routerNetwork: string;
  rtpCapabilities: RtpCapabilities;
  egress: string;
  requestId: string;
};

export type CreatedMediaProducer = {
  originId: Guid;
  producerId: Guid;
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
  appData: AppData;
  requestId: string;
};

export type ConsumeAudio = {
  consumerPeer: Guid;
  producerPeers: Guid[];
  room: string;
  rtpCaps: RtpCapabilities;
};

export type ConsumeVideo = {
  consumerPeer: Guid;
  producerPeers: Guid[];
  room: string;
  rtpCaps: RtpCapabilities;
};

export type ProducerClose = {
  peerId: Guid;
  producerId: Guid;
  mediaType: string;
};
export type ProducerClosed = {
  originId: Guid;
  producerId: Guid;
  mediaType: string;
};

export type SetProducerPaused = {
  producerId: Guid;
  paused: boolean;
};

export type CreateMediaConsumer = {
  kind: "video" | "audio";
  consumerTransports: Guid[];
  producerIds: { [key: string]: string[] }[];
  room: string;
  rtpCaps: RtpCapabilities;
};

export type CreatedMediaConsumer = {
  [transportId: string]: {
    id: string;
    producerId: string;
    producerPeerId: string;
    kind: "video" | "audio";
    rtpParameters: RtpParameters;
    appData: AppData;
  }[];
};

export type DisconnectedWebRTCTransport = {
  transportId: Guid;
  originId?: Guid;
  direction: "ingress" | "egress";
};

export type TeardownPeerSession = {
  originId: Guid;
  peerId: Guid;
  operationId: Guid;
  mode: "leaving" | "closing";
  transportIds: Guid[];
  producerIds: Guid[];
};

export type CreateRouterGroup = {
  room: string;
  origin: Guid;
};
export type DumpRouterGroup = {
  room: string;
  origin: Guid;
};
export type CreatedRouterGroup = {
  roomRTPCapabilities: RtpCapabilities;
  room: string;
  serverId: Guid;
  mode: "ingress" | "egress";
  origin: Guid;
};
export type RouterDump = {
  origin: Guid;
  room: string;
  serverId: Guid;
  mode: "ingress" | "egress";
  routers: RouterDumpEntry[];
  pipeTransports: PipeTransportDumpEntry[];
  webrtcTransportStats?: Record<string, TransportStats>;
  pipeTransportStats?: Record<string, TransportStats>;
  error?: string;
};

export type DestroyRouterGroup = {
  routerNetwork: string;
};

// Received and Sent messages to establish pipe transports
export type NetworkRelayPayload = { traceId?: Guid } & (
  | { type: "initializedNetworkRelay"; message: InitializedNetworkRelay }
  | { type: "connectNetworkRelay"; message: ConnectNetworkRelay }
  | { type: "connectedNetworkRelay"; message: ConnectedNetworkRelay }
  | { type: "finalizeNetworkRelay"; message: FinalizeNetworkRelay }
  | { type: "finalizedNetworkRelay"; message: FinalizedNetworkRelay }
);

export type InitializedNetworkRelay = {
  originId: string;
  routerNetwork: string;
  producerId: string;
  consumerOptions: PipeConsumerOptions;
  createNetworkPipeTransport: boolean;
  ingressIp: string;
  ingressPort: number;
  protocol: string;
  appData: AppData;
  egressServer: string;
};

export type ConnectNetworkRelay = {
  originId: string;
  producerId: string;
  routerNetwork: string;
  consumerOptions: PipeConsumerOptions;
  createNetworkPipeTransport: boolean;
  ingressIp: string;
  ingressPort: number;
  protocol: string;
  appData: AppData;
  ingressServer: string;
};

export type ConnectedNetworkRelay = {
  originId: string;
  routerNetwork: string;
  producerId: string;
  connectedTransport: boolean;
  egressIp: string;
  egressPort: number;
  protocol: string;
  appData: AppData;
  ingressServer: string;
};

export type FinalizeNetworkRelay = {
  originId: string;
  routerNetwork: string;
  producerId: string;
  connectedTransport: boolean;
  egressIp: string;
  egressPort: number;
  protocol: string;
  egressServer: string;
};

export type FinalizedNetworkRelay = {
  originId: string;
  producerId: string;
  routerNetwork: string;
  kind: "audio" | "video";
  ingressIp: string;
  ingressPort: number;
  egressIp: string;
  egressPort: number;
  egressServer: string;
};

export type PipeConsumerOptions = {
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
  appData?: AppData;
};

// Received messages for server state
export type ServiceMessage =
  | { type: "registerMediaServer"; message: RegisterMediaServer }
  | { type: "unregisterMediaServer"; message: UnregisterMediaServer }
  | { type: "serverLoad"; message: ServerLoad }
  | { type: "mediaDiagnostic"; message: MediaDiagnostic };

export type NsOutboundPayload = RequestPayload | NetworkRelayPayload;
export type NsInboundPayload =
  | RequestPayload
  | ResponsePayload
  | NetworkRelayPayload
  | ServiceMessage;

export type NsRequestMessageMap = {
  [M in RequestPayload as M["type"]]: M["message"];
};
export type NsResponseMessageMap = {
  [M in ResponsePayload as M["type"]]: M["message"];
};
export type NsRelayMessageMap = {
  [M in NetworkRelayPayload as M["type"]]: M["message"];
};
export type NsServiceMessageMap = {
  [M in ServiceMessage as M["type"]]: M["message"];
};
export type NsOutboundMessageMap = {
  [M in NsOutboundPayload as M["type"]]: M["message"];
};
export type NsInboundMessageMap = {
  [M in NsInboundPayload as M["type"]]: M["message"];
};

export type RegisterMediaServer = {
  registrationId: Guid;
  mode: "ingress" | "egress";
  region: string;
};
export type UnregisterMediaServer = {
  mode: "ingress" | "egress";
  region: string;
  reason?: string;
  detail?: string;
};

export type ServerLoad = {
  mode: "ingress" | "egress";
  region: string;
  load: number;
  loadPerCpu?: number[];
};

export type MediaDiagnostic = {
  mode: "ingress" | "egress";
  region: string;
  severity: "warn" | "error";
  category:
    | "websocketRequest"
    | "netsocketCommand"
    | "producerLifecycle"
    | "transportLifecycle"
    | "mediaServerLifecycle";
  message: string;
  details?: string;
  context?: Record<string, string>;
};
