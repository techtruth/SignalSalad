/**
 * Signaling runtime topology composition.
 *
 * This module builds the full signaling runtime graph (stores, ports, domain
 * services, and protocol flows) from listener dependencies and facade callbacks.
 */

import type { Guid, JoinedPeer, Peer } from "../../../types/baseTypes.d.ts";
import type { RtpCapabilities } from "mediasoup/types";
import type { SystemDiagnosticEvent } from "../../../types/wsRelay.d.ts";
import { MediaServerConnectionRegistry } from "../core/mediaServer/serverConnectionRegistry.js";
import {
  MediaServer,
  type MediaServerOfflineEvent,
} from "../core/mediaServer/mediaServer.js";
import { MediaServerRegistry } from "../core/mediaServer/serverRegistry.js";
import type {
  MediaServerLoadDetailIndex,
  MediaServerLoadIndex,
  MediaServerRegionIndex,
} from "../core/mediaServer/types.js";
import { Peer as PeerLifecycle } from "../core/peer/peer.js";
import { PeerExtendedControl } from "../core/peer/peerExtendedControl.js";
import { PeerMediaSession } from "../core/peer/peerMediaSession.js";
import { PeerSessions } from "../core/peer/peerSessions.js";
import {
  requireAttachedPeer as requireAttachedPeerState,
  requireMediaPeer as requireMediaPeerState,
  requireMediaPeerByOrigin as requireMediaPeerByOriginState,
  requirePeer as requirePeerState,
  requirePeerIdByOrigin as requirePeerIdByOriginState,
  withRtpCapabilities as withRtpCapabilitiesState,
} from "../core/peer/peerStateMachine.js";
import { PeerWebRTCTransport } from "../core/peer/peerWebRTCTransport.js";
import { ProducerRegistry } from "../core/peer/producerRegistry.js";
import { Room, type RoomContext } from "../core/room/room.js";
import { RoomRelay, type RoomRelayContext } from "../core/room/roomRelay.js";
import { RoomRoutingIndex } from "../core/room/roomRoutingIndex.js";
import type { NetsocketServer } from "../listeners/netsocketServer.js";
import type { WebSocketServer } from "../listeners/websocketServer.js";
import { StatusReporter } from "../observability/statusReporter.js";
import type { SignalingMessenger } from "../protocol/signalingMessenger.js";
import type {
  MediaInboundPayload,
  NodeId,
  NsMessageMap,
  WsMessageMap,
} from "../protocol/signalingIoValidation.js";
import type { MediaServerPipe } from "../protocol/signalingTypes.js";
import type { WebRTCTransportDetails } from "../protocol/websocketMessageBuilders.js";
import { NetsocketSignalFlow } from "./netsocketSignalFlow.js";
import { defaultAdmissionPolicy } from "./policies/admissionPolicy.js";
import { defaultRateLimitPolicy } from "./policies/rateLimitPolicy.js";
import { defaultRoomMediaPolicy } from "./policies/roomMediaPolicy.js";
import type {
  PartialSignalingPolicies,
  SignalingPolicies,
} from "./policies/types.js";
import { defaultWebRTCTransportPolicy } from "./policies/webRTCTransportPolicy.js";
import { WebsocketIngressFlow } from "./websocketIngressFlow.js";
import type { Socket as NetSocket } from "net";

/**
 * Explicit dependencies required to construct signaling.
 *
 * Listener adapters are required; region/load indexes and policy overrides are optional.
 */
export type SignalingDeps = {
  websocketServer: WebSocketServer;
  netsocketServer: NetsocketServer;
  ingressRegions?: MediaServerRegionIndex;
  egressRegions?: MediaServerRegionIndex;
  ingressLoad?: MediaServerLoadIndex;
  egressLoad?: MediaServerLoadIndex;
  ingressLoadDetail?: MediaServerLoadDetailIndex;
  egressLoadDetail?: MediaServerLoadDetailIndex;
  policies?: PartialSignalingPolicies;
};

/** Facade callbacks consumed by runtime composition helpers. */
export type SignalingRuntimeCallbacks = {
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
  sendNetsocketMessage: SignalingMessenger["sendNetsocketMessage"];
  recordDiagnostic: (event: Omit<SystemDiagnosticEvent, "at">) => void;
  getRecentDiagnostics: () => SystemDiagnosticEvent[];
};

/**
 * Merges production-safe default policies with optional overrides.
 *
 * Policy objects are treated as immutable behavior contracts for one signaling
 * instance, so this function always returns a fully-populated policy set.
 */
const createSignalingPolicies = (
  overrides?: PartialSignalingPolicies,
): SignalingPolicies => ({
  admission: {
    ...defaultAdmissionPolicy,
    ...overrides?.admission,
  },
  roomMedia: {
    ...defaultRoomMediaPolicy,
    ...overrides?.roomMedia,
  },
  webRTCTransport: {
    ...defaultWebRTCTransportPolicy,
    ...overrides?.webRTCTransport,
  },
  rateLimit: {
    ...defaultRateLimitPolicy,
    ...overrides?.rateLimit,
  },
});

/**
 * Upper bound for retained disconnected media-server lifecycle snapshots.
 *
 * Keeps diagnostics bounded even when churn is high (restarts, deploys, flaps).
 */
const MAX_DISCONNECTED_MEDIA_SERVER_LIFECYCLES = 256;

/**
 * Builds a signaling-scoped accessor bundle over peer/session state.
 *
 * These wrappers centralize invariant scope labels so core peer state-machine
 * errors are consistently attributed to signaling orchestration.
 */
const createPeerStateAccessors = (params: {
  peers: Map<Guid, Peer>;
  sessions: PeerSessions;
}) => ({
  requirePeer: (peerId: Guid, context: string) =>
    requirePeerState({
      peers: params.peers,
      peerId,
      context,
      invariantScope: "signaling",
    }),
  requireAttachedPeer: (peerId: Guid, context: string) =>
    requireAttachedPeerState({
      peers: params.peers,
      peerId,
      context,
      invariantScope: "signaling",
    }),
  requireMediaPeer: (peerId: Guid, context: string) =>
    requireMediaPeerState({
      peers: params.peers,
      peerId,
      context,
      invariantScope: "signaling",
    }),
  withRtpCapabilities: (peer: JoinedPeer, rtpCapabilities: RtpCapabilities) =>
    withRtpCapabilitiesState({
      peer,
      rtpCapabilities,
      context: "signaling",
    }),
  requirePeerIdByOrigin: (originId: Guid, context: string) =>
    requirePeerIdByOriginState({
      sessions: params.sessions,
      originId,
      context,
    }),
  requireMediaPeerByOrigin: (originId: Guid, context: string) =>
    requireMediaPeerByOriginState({
      peers: params.peers,
      sessions: params.sessions,
      originId,
      context,
      invariantScope: "signaling",
    }),
  savePeer: (peer: Peer) => params.sessions.savePeer(peer),
});

type PeerStateAccessors = ReturnType<typeof createPeerStateAccessors>;

/**
 * Pipe registry port used by room-relay + peer-media orchestration.
 *
 * It extends the relay contract with lifecycle utilities that are only needed
 * at the signaling composition layer.
 */
type SignalingPipeRegistry = RoomRelayContext["pipeRegistry"] & {
  listPipes(): readonly MediaServerPipe[];
  replacePipes(nextPipes: MediaServerPipe[]): void;
  stripProducersFromPipes(producerIds: Set<Guid>): void;
};

/**
 * In-memory implementation of the signaling pipe registry.
 *
 * Pipe records are mutable lifecycle entities owned by one signaling process.
 */
class InMemorySignalingPipeRegistry implements SignalingPipeRegistry {
  private readonly pipes: MediaServerPipe[];

  constructor(pipes: MediaServerPipe[]) {
    this.pipes = pipes;
  }

  listPipes() {
    return this.pipes as readonly MediaServerPipe[];
  }

  replacePipes(nextPipes: MediaServerPipe[]) {
    this.pipes.length = 0;
    this.pipes.push(...nextPipes);
  }

  findPipe(lookup: {
    ingress: Guid;
    egress: Guid;
    room: string;
    ingressPort: number;
    egressPort: number;
  }) {
    return this.pipes.find(
      (pipe) =>
        pipe.ingress === lookup.ingress &&
        pipe.egress === lookup.egress &&
        pipe.room === lookup.room &&
        pipe.ingressPort === lookup.ingressPort &&
        pipe.egressPort === lookup.egressPort,
    );
  }

  addPipe(pipe: MediaServerPipe) {
    this.pipes.push(pipe);
  }

  stripProducersFromPipes(producerIds: Set<Guid>) {
    for (const pipe of this.pipes) {
      pipe.producerIds = pipe.producerIds.filter((id) => !producerIds.has(id));
    }
  }
}

type RoomMembershipPort = RoomContext["membership"];

/**
 * Room membership port backed by peer sessions + peer state accessors.
 */
class SessionRoomMembership implements RoomMembershipPort {
  private readonly sessions: Pick<PeerSessions, "getRoomPeerIds">;
  private readonly peers: Map<Guid, Peer>;
  private readonly peerState: Pick<PeerStateAccessors, "requireAttachedPeer">;

  constructor(params: {
    sessions: Pick<PeerSessions, "getRoomPeerIds">;
    peers: Map<Guid, Peer>;
    peerState: Pick<PeerStateAccessors, "requireAttachedPeer">;
  }) {
    this.sessions = params.sessions;
    this.peers = params.peers;
    this.peerState = params.peerState;
  }

  getRoomPeerIds(room: string) {
    return this.sessions.getRoomPeerIds(room);
  }

  getPeer(peerId: Guid) {
    return this.peers.get(peerId);
  }

  requireAttachedPeer(peerId: Guid, context: string) {
    return this.peerState.requireAttachedPeer(peerId, context);
  }
}

/** Long-lived signaling state stores (maps/indexes) shared across services. */
type SignalingStores = {
  sessions: PeerSessions;
  peers: Map<Guid, Peer>;
  producers: ProducerRegistry;
  ingressTransportDetails: Map<Guid, WebRTCTransportDetails>;
  egressTransportDetails: Map<Guid, WebRTCTransportDetails>;
  ingressServerSockets: Map<Guid, NetSocket>;
  egressServerSockets: Map<Guid, NetSocket>;
  ingressRegions: MediaServerRegionIndex;
  egressRegions: MediaServerRegionIndex;
  ingressLoad: MediaServerLoadIndex;
  egressLoad: MediaServerLoadIndex;
  ingressLoadDetail: MediaServerLoadDetailIndex;
  egressLoadDetail: MediaServerLoadDetailIndex;
  roomRouting: RoomRoutingIndex;
  pipes: MediaServerPipe[];
  serverOfflineEvents: Record<string, MediaServerOfflineEvent>;
  diagnosticsRecent: SystemDiagnosticEvent[];
};

/** External listener ports and transport-facing adapters used by signaling. */
type SignalingPorts = {
  websocketServer: WebSocketServer;
  netsocketServer: NetsocketServer;
  pipeRegistry: SignalingPipeRegistry;
  connectionRegistry: MediaServerConnectionRegistry<NetSocket>;
  signalingMessenger: SignalingMessenger;
  statusReporter: StatusReporter;
};

/** Core domain services wired by signaling composition root. */
type SignalingServices = {
  serverRegistry: MediaServerRegistry;
  room: Room;
  roomRelay: RoomRelay;
  peerLifecycle: PeerLifecycle;
  peerExtendedControl: PeerExtendedControl;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
  mediaServer: MediaServer;
  netsocketFlow: NetsocketSignalFlow;
  websocketFlow: WebsocketIngressFlow;
};

/** Fully-wired runtime container retained by the signaling facade. */
export type SignalingRuntime = {
  stores: SignalingStores;
  ports: SignalingPorts;
  services: SignalingServices;
  policies: SignalingPolicies;
};

/** Builds long-lived in-memory signaling stores. */
const buildSignalingStores = (deps: SignalingDeps): SignalingStores => {
  const sessions = new PeerSessions();
  const peers = sessions.getPeerMap();
  const producers = new ProducerRegistry();
  return {
    sessions,
    peers,
    producers,
    ingressTransportDetails: new Map(),
    egressTransportDetails: new Map(),
    ingressServerSockets: deps.netsocketServer.getServersByMode("ingress"),
    egressServerSockets: deps.netsocketServer.getServersByMode("egress"),
    ingressRegions: deps.ingressRegions ?? {},
    egressRegions: deps.egressRegions ?? {},
    ingressLoad: deps.ingressLoad ?? {},
    egressLoad: deps.egressLoad ?? {},
    ingressLoadDetail: deps.ingressLoadDetail ?? {},
    egressLoadDetail: deps.egressLoadDetail ?? {},
    roomRouting: new RoomRoutingIndex(),
    pipes: [],
    serverOfflineEvents: {},
    diagnosticsRecent: [],
  };
};

/** Builds adapter ports over listeners + observability surfaces. */
const buildSignalingPorts = (params: {
  deps: SignalingDeps;
  stores: SignalingStores;
  callbacks: SignalingRuntimeCallbacks;
}): SignalingPorts => {
  const { deps, stores, callbacks } = params;
  const pipeRegistry = new InMemorySignalingPipeRegistry(stores.pipes);
  const connectionRegistry = new MediaServerConnectionRegistry<NetSocket>({
    transport: deps.netsocketServer,
    identities: new WeakMap(),
    resolveConnectionAddress: (connection) => connection.remoteAddress,
  });
  const signalingMessenger: SignalingMessenger = {
    sendWebsocketMessage: callbacks.sendWebsocketMessage,
    sendNetsocketMessage: callbacks.sendNetsocketMessage,
  };
  const statusReporter = new StatusReporter({
    peers: stores.peers,
    sessions: stores.sessions,
    producers: stores.producers,
    wsClients: deps.websocketServer.getClients(),
    ingress: stores.ingressServerSockets,
    egress: stores.egressServerSockets,
    ingressRegions: stores.ingressRegions,
    egressRegions: stores.egressRegions,
    routingTable: stores.roomRouting.getRoutingTable(),
    ingressLoad: stores.ingressLoad,
    egressLoad: stores.egressLoad,
    ingressLoadDetail: stores.ingressLoadDetail,
    egressLoadDetail: stores.egressLoadDetail,
    pipes: stores.pipes,
    serverOfflineEvents: stores.serverOfflineEvents,
    diagnosticsRecent: callbacks.getRecentDiagnostics,
    recordDiagnostic: callbacks.recordDiagnostic,
    statusSubscribers: deps.websocketServer.getStatusSubscribers(),
    signalingMessenger,
  });

  return {
    websocketServer: deps.websocketServer,
    netsocketServer: deps.netsocketServer,
    pipeRegistry,
    connectionRegistry,
    signalingMessenger,
    statusReporter,
  };
};

type SignalingPeerServices = {
  peerLifecycle: PeerLifecycle;
  peerExtendedControl: PeerExtendedControl;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
};

/** Builds media-server registry service used by admission + load selection. */
const buildServerRegistry = (stores: SignalingStores) =>
  new MediaServerRegistry({
    ingressRegions: stores.ingressRegions,
    egressRegions: stores.egressRegions,
    ingressLoad: stores.ingressLoad,
    egressLoad: stores.egressLoad,
    ingressLoadDetail: stores.ingressLoadDetail,
    egressLoadDetail: stores.egressLoadDetail,
    maxDisconnectedServers: MAX_DISCONNECTED_MEDIA_SERVER_LIFECYCLES,
  });

/** Builds room service with session-backed membership adapter. */
const buildRoomService = (params: {
  stores: SignalingStores;
  ports: SignalingPorts;
  peerState: PeerStateAccessors;
}) => {
  const membership = new SessionRoomMembership({
    sessions: params.stores.sessions,
    peers: params.stores.peers,
    peerState: params.peerState,
  });
  return new Room({
    roomRouting: params.stores.roomRouting,
    membership,
    signalingMessenger: params.ports.signalingMessenger,
  });
};

/** Builds peer-owned lifecycle/control/media transport services. */
const buildPeerServices = (params: {
  stores: SignalingStores;
  ports: SignalingPorts;
  callbacks: SignalingRuntimeCallbacks;
  room: Room;
  serverRegistry: MediaServerRegistry;
  peerState: PeerStateAccessors;
}): SignalingPeerServices => {
  const peerWebRTCTransport = new PeerWebRTCTransport({
    peers: params.stores.peers,
    sessions: params.stores.sessions,
    producers: params.stores.producers,
    ingressTransportDetails: params.stores.ingressTransportDetails,
    egressTransportDetails: params.stores.egressTransportDetails,
    peerState: params.peerState,
    signalingMessenger: params.ports.signalingMessenger,
    room: params.room,
    pipeRegistry: params.ports.pipeRegistry,
    recordDiagnostic: params.callbacks.recordDiagnostic,
  });

  const peerMediaSession = new PeerMediaSession({
    peers: params.stores.peers,
    sessions: params.stores.sessions,
    producers: params.stores.producers,
    egressRegistry: params.stores.egressServerSockets,
    room: params.room,
    peerState: params.peerState,
    pipeRegistry: params.ports.pipeRegistry,
    signalingMessenger: params.ports.signalingMessenger,
    recordDiagnostic: params.callbacks.recordDiagnostic,
  });

  const peerLifecycle = new PeerLifecycle({
    sessions: params.stores.sessions,
    producers: params.stores.producers,
    room: params.room,
    pipeRegistry: params.ports.pipeRegistry,
    signalingMessenger: params.ports.signalingMessenger,
    serverRegistry: params.serverRegistry,
    peerWebRTCTransport,
    peerMediaSession,
    statusReporter: params.ports.statusReporter,
    recordDiagnostic: params.callbacks.recordDiagnostic,
  });

  const peerExtendedControl = new PeerExtendedControl({
    peerState: params.peerState,
    signalingMessenger: params.ports.signalingMessenger,
    mediaSession: peerMediaSession,
  });

  return {
    peerLifecycle,
    peerExtendedControl,
    peerWebRTCTransport,
    peerMediaSession,
  };
};

/** Builds media-server lifecycle service over netsocket transport port. */
const buildMediaServerService = (params: {
  stores: SignalingStores;
  ports: SignalingPorts;
  callbacks: SignalingRuntimeCallbacks;
  serverRegistry: MediaServerRegistry;
  peerLifecycle: PeerLifecycle;
}) =>
  new MediaServer<NetSocket>({
    peers: params.stores.peers,
    peer: params.peerLifecycle,
    roomRouting: params.stores.roomRouting,
    producers: params.stores.producers,
    transport: params.ports.netsocketServer,
    connectionRegistry: params.ports.connectionRegistry,
    pipeRegistry: params.ports.pipeRegistry,
    serverOfflineEvents: params.stores.serverOfflineEvents,
    serverRegistry: params.serverRegistry,
    statusReporter: params.ports.statusReporter,
    recordDiagnostic: params.callbacks.recordDiagnostic,
  });

/** Builds room-relay service that coordinates ingress/egress inter-server pipes. */
const buildRoomRelayService = (params: {
  ports: SignalingPorts;
  peerMediaSession: PeerMediaSession;
}) =>
  new RoomRelay({
    pipeRegistry: params.ports.pipeRegistry,
    serverAddressRegistry: params.ports.connectionRegistry,
    signalingMessenger: params.ports.signalingMessenger,
    consumerPlanner: params.peerMediaSession,
  });

type SignalingFlowServices = {
  netsocketFlow: NetsocketSignalFlow;
  websocketFlow: WebsocketIngressFlow;
};

/** Builds transport ingress flows that bind protocol dispatch to domain services. */
const buildSignalingFlows = (params: {
  stores: SignalingStores;
  ports: SignalingPorts;
  callbacks: SignalingRuntimeCallbacks;
  policies: SignalingPolicies;
  serverRegistry: MediaServerRegistry;
  room: Room;
  roomRelay: RoomRelay;
  peerLifecycle: PeerLifecycle;
  peerExtendedControl: PeerExtendedControl;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
  mediaServer: MediaServer;
}): SignalingFlowServices => {
  const netsocketFlow = new NetsocketSignalFlow({
    mediaServer: params.mediaServer,
    roomRelay: params.roomRelay,
    peerWebRTCTransport: params.peerWebRTCTransport,
    peerMediaSession: params.peerMediaSession,
    statusReporter: params.ports.statusReporter,
    sessions: params.stores.sessions,
    peers: params.stores.peers,
    producers: params.stores.producers,
    recordDiagnostic: params.callbacks.recordDiagnostic,
    sendWebsocketMessage: params.ports.signalingMessenger.sendWebsocketMessage,
  });

  const websocketFlow = new WebsocketIngressFlow({
    policies: params.policies,
    sessions: params.stores.sessions,
    serverRegistry: params.serverRegistry,
    peerLifecycle: params.peerLifecycle,
    peerExtendedControl: params.peerExtendedControl,
    peerWebRTCTransport: params.peerWebRTCTransport,
    peerMediaSession: params.peerMediaSession,
    room: params.room,
    websocketServer: params.ports.websocketServer,
    statusReporter: params.ports.statusReporter,
    sendWebsocketMessage: params.ports.signalingMessenger.sendWebsocketMessage,
    recordDiagnostic: params.callbacks.recordDiagnostic,
  });

  return {
    netsocketFlow,
    websocketFlow,
  };
};

/** Builds domain services and protocol flows over stores/ports. */
const buildSignalingServices = (params: {
  stores: SignalingStores;
  ports: SignalingPorts;
  policies: SignalingPolicies;
  callbacks: SignalingRuntimeCallbacks;
}): SignalingServices => {
  const { stores, ports, policies, callbacks } = params;
  const peerState = createPeerStateAccessors({
    peers: stores.peers,
    sessions: stores.sessions,
  });
  const serverRegistry = buildServerRegistry(stores);
  const room = buildRoomService({
    stores,
    ports,
    peerState,
  });
  const {
    peerLifecycle,
    peerExtendedControl,
    peerWebRTCTransport,
    peerMediaSession,
  } = buildPeerServices({
    stores,
    ports,
    callbacks,
    room,
    serverRegistry,
    peerState,
  });
  const mediaServer = buildMediaServerService({
    stores,
    ports,
    callbacks,
    serverRegistry,
    peerLifecycle,
  });
  const roomRelay = buildRoomRelayService({
    ports,
    peerMediaSession,
  });
  const { netsocketFlow, websocketFlow } = buildSignalingFlows({
    stores,
    ports,
    callbacks,
    policies,
    serverRegistry,
    room,
    roomRelay,
    peerLifecycle,
    peerExtendedControl,
    peerWebRTCTransport,
    peerMediaSession,
    mediaServer,
  });

  return {
    serverRegistry,
    room,
    roomRelay,
    peerLifecycle,
    peerExtendedControl,
    peerWebRTCTransport,
    peerMediaSession,
    mediaServer,
    netsocketFlow,
    websocketFlow,
  };
};

/** Composes the full signaling runtime from deps + facade callbacks. */
export const composeSignalingRuntime = (params: {
  deps: SignalingDeps;
  callbacks: SignalingRuntimeCallbacks;
}): SignalingRuntime => {
  const stores = buildSignalingStores(params.deps);
  const policies = createSignalingPolicies(params.deps.policies);
  const ports = buildSignalingPorts({
    deps: params.deps,
    stores,
    callbacks: params.callbacks,
  });
  const services = buildSignalingServices({
    stores,
    ports,
    policies,
    callbacks: params.callbacks,
  });
  return {
    stores,
    ports,
    services,
    policies,
  };
};

/** Shared signaling handler parameter aliases. */
export type { MediaInboundPayload, NodeId, NsMessageMap, WsMessageMap };
