import type {
  ProducerOptions,
  RtpCapabilities,
  RtpParameters,
  DtlsParameters,
  AppData,
  SctpParameters,
  IceParameters,
  IceCandidate,
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

import type { Guid, Peer } from "./baseTypes";

export type NumSctpStreams = {
  OS: number;
  MIS: number;
};

// Received messages from websocket client
export type RequestMessage =
  | { type: "requestIdentity"; message: RequestIdentity }
  | { type: "joinRoom"; message: JoinRoom }
  | { type: "createIngress"; message: CreateIngress }
  | { type: "createEgress"; message: CreateEgress }
  | { type: "connectIngress"; message: ConnectIngress }
  | { type: "connectEgress"; message: ConnectEgress }
  | { type: "produceMedia"; message: ProduceMedia }
  | { type: "producerClose"; message: ProducerClose }
  | { type: "requestRoomAudio"; message: RequestRoomAudio }
  | { type: "requestRoomVideo"; message: RequestRoomVideo }
  | { type: "disconnectPeerWebsocket"; message: Disconnect }
  | { type: "leaveRoom"; message: LeaveRoom }
  | { type: "mutePeer"; message: MutePeer }
  | { type: "requestSystemStatus"; message: RequestSystemStatus };

// Sent messages from signaling websocket server to client
export type ResponseMessage =
  | { type: "identity"; message: Identity }
  | { type: "joinedRoom"; message: JoinedRoom }
  | { type: "createdIngress"; message: CreatedIngress }
  | { type: "createdEgress"; message: CreatedEgress }
  | { type: "connectedIngress"; message: {} }
  | { type: "connectedEgress"; message: {} }
  | { type: "producedMedia"; message: ProducedMedia }
  | { type: "producerClosed"; message: ProducerClose }
  | { type: "roomAudio"; message: RequestPeer }
  | { type: "roomVideo"; message: RequestPeer }
  | { type: "roomAttached"; message: RoomAttached }
  | { type: "roomEgressReady"; message: RoomEgressReady }
  | { type: "roomDetached"; message: RoomDetached }
  | { type: "mediaAnnouncement"; message: MediaAnnouncement }
  | { type: "systemStatus"; message: SystemStatus }
  | { type: "peerConnected"; message: PeerConnected }
  | { type: "peerDisconnected"; message: { peerId: Guid; room?: string } }
  | { type: "peerMuteRequested"; message: PeerMuteRequested }
  | { type: "error"; message: { error: string; detail?: string } };

export type WsRequestMessageMap = {
  [M in RequestMessage as M["type"]]: M["message"];
};
export type WsResponseMessageMap = {
  [M in ResponseMessage as M["type"]]: M["message"];
};

export type RequestIdentity = { region: string };
export type Identity = {
  peerId: Guid;
  originId: Guid;
  region: string;
};

export type JoinRoom = { peerId: Guid; room: string };
export type JoinedRoom = {
  roomRTPCapabilities: RtpCapabilities;
  room: string;
  serverId: Guid;
  mode: "ingress" | "egress";
};

export type CreateIngress = {
  peerId: Guid;
  room: string;
  numStreams: NumSctpStreams;
  rtpCapabilities: RtpCapabilities;
  serverId?: Guid;
};
export type CreatedIngress = {
  transportId: Guid;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
};
export type CreateEgress = {
  peerId: Guid;
  room: string;
  numStreams: NumSctpStreams;
  rtpCapabilities: RtpCapabilities;
  serverId: Guid;
};
export type CreatedEgress = {
  transportId: Guid;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
  egressServer: Guid;
};
export type ConnectIngress = {
  peerId: Guid;
  transportId: Guid;
  room?: string;
  dtlsParameters: DtlsParameters;
};
export type ConnectEgress = {
  peerId: Guid;
  transportId: Guid;
  room?: string;
  dtlsParameters: DtlsParameters;
  serverId: Guid;
};
export type ProduceMedia = {
  producingPeer: Guid;
  transportId: Guid;
  producerOptions: ProducerOptions;
  requestId: string;
};
export type ProducedMedia = {
  id: Guid;
  appData: AppData;
  requestId: string;
};
export type ProducerClose = {
  originId: Guid;
  producerId: Guid;
  mediaType: string;
};

export type RequestRoomAudio = {
  requestingPeer: Guid;
};
export type RequestRoomVideo = {
  requestingPeer: Guid;
};

export type RequestPeer = {
  requestingPeer: Guid;
};

export type PeerConnected = {
  peerId: Guid;
  room: string;
};

export type Disconnect = {
  code: number;
  transport: Guid;
};
export type LeaveRoom = {
  peerId: Guid;
  room: string;
};

export type MutePeer = {
  requestingPeer: Guid;
  targetPeer: Guid;
  scope: "client" | "server";
  muted: boolean;
};

export type PeerMuteRequested = {
  requesterPeerId: Guid;
  muted: boolean;
};

export type RoomAttached = {
  peerId: Guid;
  room: string;
  egressServers?: Guid[];
  roomPeers?: Guid[];
};

export type RoomEgressReady = {
  room: string;
  egressServers: Guid[];
};

export type RoomDetached = {
  peerId: Guid;
  room: string;
};
export type MediaAnnouncement = {
  producerPeerId: Guid;
  transportId: Guid;
  id: Guid;
  producerId: Guid;
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
  appData: AppData;
  streamId?: Guid;
}[];

export type RequestSystemStatus = {};

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

export type SystemDiagnosticEvent = {
  at: string;
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

export type SystemStatus = {
  wsClients: Guid[];
  ingress: Guid[];
  egress: Guid[];
  ingressRegions: { [region: string]: Guid[] };
  egressRegions: { [region: string]: Guid[] };
  routingTable: {
    [routerNetwork: string]: { ingress: Guid[]; egress: Guid[] };
  };
  ingressLoad: { [region: string]: { [serverId: string]: number } };
  egressLoad: { [region: string]: { [serverId: string]: number } };
  ingressLoadDetail?: {
    [region: string]: { [serverId: string]: { avg: number; perCpu: number[] } };
  };
  egressLoadDetail?: {
    [region: string]: { [serverId: string]: { avg: number; perCpu: number[] } };
  };
  pipes: {
    ingress: Guid;
    egress: Guid;
    ingressPort: number;
    egressPort: number;
    room: string;
    producerIds: Guid[];
  }[];
  pipesObserved: {
    ingress: Guid;
    egress: Guid;
    ingressPort: number;
    egressPort: number;
    room: string;
    producerIds: Guid[];
  }[];
  routerDumps?: { [key: string]: RouterDump };
  serverOfflineEvents?: {
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
  diagnosticsRecent?: SystemDiagnosticEvent[];
  originID_to_peerID: { [originId: string]: Guid };
  egressTransportID_to_peerID: { [egressId: string]: Guid };
  peers: { [peerId: string]: Peer };
};
