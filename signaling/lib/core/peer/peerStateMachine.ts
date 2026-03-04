import type { RtpCapabilities } from "mediasoup/types";
import type {
  AttachedPeer,
  Guid,
  JoinedPeer,
  LobbyPeer,
  MediaFailedPeer,
  MediaReadyPeer,
  MediaState,
  Peer,
  RoomState,
} from "../../../../types/baseTypes.d.ts";

/**
 * Peer state model:
 * - Room machine: lobby <-> joined
 * - Media machine: none <-> ready, with failed + recovery path
 *
 * The two machines operate together through a strict invariant check so
 * invalid cross-product combinations cannot silently exist in memory.
 */
export type RoomEvent = "joinRequested" | "leaveRequested" | "peerDisconnected";
/** Events that transition the peer media-state machine. */
export type MediaEvent =
  | "mediaReadyReported"
  | "mediaCleared"
  | "mediaFailedReported"
  // Reserved for future client-driven renegotiation/recovery flow.
  | "mediaRecoveryRequested";

/** Union of all supported peer lifecycle events (room + media). */
export type PeerEvent =
  | {
      type: "joinRequested";
      room: string;
      ingress: Guid;
      egress: Guid;
    }
  | { type: "leaveRequested" }
  | { type: "peerDisconnected" }
  | { type: "mediaReadyReported"; rtpCapabilities: RtpCapabilities }
  | { type: "mediaCleared" }
  | { type: "mediaFailedReported" }
  | { type: "mediaRecoveryRequested" };

/** Reserved side-effect channel for reducer outputs (currently unused). */
export type PeerEffect = never;

/** Result envelope produced by peer reducer transitions. */
export type PeerReducerResult = {
  updatedPeer: Peer;
  effects: PeerEffect[];
};
/** Transport direction discriminator used by transport binding helpers. */
export type PeerTransportDirection = "ingress" | "egress";

const ROOM_EVENT_TRANSITIONS: Record<
  RoomState,
  Partial<Record<RoomEvent, RoomState>>
> = {
  lobby: {
    joinRequested: "joined",
    peerDisconnected: "lobby",
  },
  joined: {
    leaveRequested: "lobby",
    peerDisconnected: "lobby",
  },
};

const MEDIA_EVENT_TRANSITIONS: Record<
  MediaState,
  Partial<Record<MediaEvent, MediaState>>
> = {
  none: {
    mediaReadyReported: "ready",
    mediaCleared: "none",
    mediaFailedReported: "failed",
  },
  ready: {
    mediaCleared: "none",
    mediaFailedReported: "failed",
  },
  failed: {
    mediaRecoveryRequested: "none",
    mediaReadyReported: "ready",
    mediaCleared: "none",
  },
};

const assertNever = (value: never, context: string): never => {
  throw new Error(
    `${context} blocked: unknown discriminator '${String(value)}'`,
  );
};

const requireValue = <T>(value: T | undefined | null, message: string): T => {
  if (value === undefined || value === null) {
    throw new Error(message);
  }
  return value;
};

/**
 * Typed state-transition failure used across peer lifecycle guards/reducers.
 */
export class PeerStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeerStateError";
  }
}

/**
 * Returns a shallow peer clone with only one transport map replaced.
 */
const clonePeerWithTransportMap = <T extends Peer>(params: {
  peer: T;
  direction: PeerTransportDirection;
  map: Record<string, string>;
}): T => {
  if (params.direction === "ingress") {
    return {
      ...params.peer,
      transportIngress: params.map,
    } as T;
  }
  return {
    ...params.peer,
    transportEgress: params.map,
  } as T;
};

/**
 * Binds a transport id to the peer under the given server id and direction.
 */
export const bindPeerTransport = <T extends Peer>(params: {
  peer: T;
  direction: PeerTransportDirection;
  serverId: Guid;
  transportId: Guid;
  context: string;
}): T => {
  const currentMap =
    params.direction === "ingress"
      ? params.peer.transportIngress
      : params.peer.transportEgress;
  const updatedMap = {
    ...currentMap,
    [params.serverId]: params.transportId,
  };
  const updatedPeer = clonePeerWithTransportMap({
    peer: params.peer,
    direction: params.direction,
    map: updatedMap,
  });
  assertValidPeerInvariant(updatedPeer, `${params.context}:afterBindTransport`);
  return updatedPeer;
};

/**
 * Removes the transport mapped for a specific media server id (if present).
 */
export const unbindPeerTransportForServer = <T extends Peer>(params: {
  peer: T;
  direction: PeerTransportDirection;
  serverId: Guid;
  context: string;
}): {
  updatedPeer: T;
  removedTransportId?: Guid;
} => {
  const currentMap =
    params.direction === "ingress"
      ? params.peer.transportIngress
      : params.peer.transportEgress;
  const removedTransportId = currentMap[params.serverId];
  if (!removedTransportId) {
    return { updatedPeer: params.peer };
  }
  const updatedMap = { ...currentMap };
  delete updatedMap[params.serverId];
  const updatedPeer = clonePeerWithTransportMap({
    peer: params.peer,
    direction: params.direction,
    map: updatedMap,
  });
  assertValidPeerInvariant(
    updatedPeer,
    `${params.context}:afterUnbindTransportForServer`,
  );
  return { updatedPeer, removedTransportId };
};

/**
 * Removes a transport mapping by transport id regardless of server id key.
 */
export const unbindPeerTransportById = <T extends Peer>(params: {
  peer: T;
  direction: PeerTransportDirection;
  transportId: Guid;
  context: string;
}): {
  updatedPeer: T;
  removed: boolean;
} => {
  const currentMap =
    params.direction === "ingress"
      ? params.peer.transportIngress
      : params.peer.transportEgress;
  let removed = false;
  const updatedMap: Record<string, string> = {};
  for (const [serverId, mappedTransportId] of Object.entries(currentMap)) {
    if (mappedTransportId === params.transportId) {
      removed = true;
      continue;
    }
    updatedMap[serverId] = mappedTransportId;
  }
  if (!removed) {
    return { updatedPeer: params.peer, removed: false };
  }
  const updatedPeer = clonePeerWithTransportMap({
    peer: params.peer,
    direction: params.direction,
    map: updatedMap,
  });
  assertValidPeerInvariant(
    updatedPeer,
    `${params.context}:afterUnbindTransportById`,
  );
  return { updatedPeer, removed: true };
};

/**
 * Clears transport and producer runtime bindings without changing lifecycle state fields.
 */
export const clearPeerRuntimeBindings = <T extends Peer>(params: {
  peer: T;
  context: string;
}): T => {
  const updatedPeer = {
    ...params.peer,
    transportIngress: {},
    transportEgress: {},
    mediaProducers: {},
  } as T;
  assertValidPeerInvariant(
    updatedPeer,
    `${params.context}:afterClearPeerRuntimeBindings`,
  );
  return updatedPeer;
};

const toExpectedLabel = <T extends string>(expected: T | T[]) =>
  Array.isArray(expected) ? expected.join("|") : expected;

const toRoomLabel = (room: string | undefined) => room ?? "none";

const buildStateError = (params: {
  context: string;
  peerId: Guid;
  currentRoomState: RoomState;
  currentMediaState: MediaState;
  expectedRoomState?: RoomState | RoomState[];
  expectedMediaState?: MediaState | MediaState[];
  targetRoomState?: RoomState;
  targetMediaState?: MediaState;
  event?: RoomEvent | MediaEvent;
  reason: string;
}) => {
  const details = [
    `peer=${params.peerId}`,
    `currentRoomState=${params.currentRoomState}`,
    `currentMediaState=${params.currentMediaState}`,
  ];
  if (params.expectedRoomState) {
    details.push(
      `expectedRoomState=${toExpectedLabel(params.expectedRoomState)}`,
    );
  }
  if (params.expectedMediaState) {
    details.push(
      `expectedMediaState=${toExpectedLabel(params.expectedMediaState)}`,
    );
  }
  if (params.targetRoomState) {
    details.push(`targetRoomState=${params.targetRoomState}`);
  }
  if (params.targetMediaState) {
    details.push(`targetMediaState=${params.targetMediaState}`);
  }
  if (params.event) {
    details.push(`event=${params.event}`);
  }
  details.push(`reason=${params.reason}`);
  return `${params.context} blocked: ${details.join(", ")}`;
};

/**
 * Builds a rich, peer-scoped failure message for guard and transition violations.
 */
export const buildPeerFailure = (params: {
  context: string;
  peer: Peer;
  reason: string;
  expectedRoomState?: RoomState | RoomState[];
  expectedMediaState?: MediaState | MediaState[];
  targetRoomState?: RoomState;
  targetMediaState?: MediaState;
  event?: RoomEvent | MediaEvent;
  expectedRoom?: string;
  targetRoom?: string;
  details?: string[];
}) => {
  const base = buildStateError({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: params.expectedRoomState,
    expectedMediaState: params.expectedMediaState,
    targetRoomState: params.targetRoomState,
    targetMediaState: params.targetMediaState,
    event: params.event,
    reason: params.reason,
  });

  const roomDetails = [`currentRoom=${toRoomLabel(params.peer.room)}`];
  if (params.expectedRoom) {
    roomDetails.push(`expectedRoom=${params.expectedRoom}`);
  }
  if (params.targetRoom) {
    roomDetails.push(`targetRoom=${params.targetRoom}`);
  }
  if (params.details?.length) {
    roomDetails.push(...params.details);
  }

  return `${base}, ${roomDetails.join(", ")}`;
};

/**
 * Enforces cross-field peer invariants so invalid room/media combinations fail fast.
 */
export const assertValidPeerInvariant = (peer: Peer, context: string) => {
  if (peer.roomState === "lobby") {
    if (
      peer.mediaState !== "none" ||
      peer.room !== undefined ||
      peer.ingress !== undefined ||
      peer.egress !== undefined ||
      peer.deviceRTPCapabilities !== undefined ||
      peer.isLobby !== true
    ) {
      throw new PeerStateError(
        buildStateError({
          context,
          peerId: peer.id,
          currentRoomState: peer.roomState,
          currentMediaState: peer.mediaState,
          expectedRoomState: "lobby",
          expectedMediaState: "none",
          reason:
            "lobby invariant violated; lobby peers cannot hold room/media bindings",
        }),
      );
    }
    return;
  }
  if (peer.roomState === "joined") {
    if (!peer.room || !peer.ingress || !peer.egress || peer.isLobby !== false) {
      throw new PeerStateError(
        buildStateError({
          context,
          peerId: peer.id,
          currentRoomState: peer.roomState,
          currentMediaState: peer.mediaState,
          expectedRoomState: "joined",
          reason:
            "joined invariant violated; joined peers must have room and server bindings",
        }),
      );
    }
    const runtimePeer = peer as JoinedPeer & {
      deviceRTPCapabilities?: RtpCapabilities;
    };
    if (
      peer.mediaState === "ready" &&
      runtimePeer.deviceRTPCapabilities === undefined
    ) {
      throw new PeerStateError(
        buildStateError({
          context,
          peerId: peer.id,
          currentRoomState: peer.roomState,
          currentMediaState: peer.mediaState,
          expectedMediaState: "ready",
          reason:
            "ready invariant violated; media-ready peers must include RTP capabilities",
        }),
      );
    }
    if (
      (peer.mediaState === "none" || peer.mediaState === "failed") &&
      runtimePeer.deviceRTPCapabilities !== undefined
    ) {
      throw new PeerStateError(
        buildStateError({
          context,
          peerId: peer.id,
          currentRoomState: peer.roomState,
          currentMediaState: peer.mediaState,
          expectedMediaState: ["none", "failed"],
          reason:
            "media invariant violated; non-ready peers cannot keep RTP capabilities",
        }),
      );
    }
    return;
  }
  return assertNever(peer as never, `${context}:assertValidPeerInvariant`);
};

/**
 * Returns true when a peer is attached to a room.
 */
export const isPeerJoined = (peer: Peer) => peer.roomState === "joined";
/**
 * Returns true when a peer has completed media setup.
 */
export const isPeerMediaReady = (peer: Peer) => peer.mediaState === "ready";

/**
 * Human-readable explanation for why a join request should be rejected.
 */
export const describeJoinRequestBlockReason = (peer: Peer) => {
  if (peer.roomState === "joined" && peer.mediaState === "none" && peer.room) {
    return `peer is already joined to room '${peer.room}'`;
  }
  if (peer.roomState === "joined" && peer.mediaState === "ready" && peer.room) {
    return `peer is already media-ready in room '${peer.room}'`;
  }
  if (
    peer.roomState === "joined" &&
    peer.mediaState === "failed" &&
    peer.room
  ) {
    return `peer is joined to room '${peer.room}' with failed media state`;
  }
  return "peer must leave its current lifecycle state before joining a room";
};

/**
 * Narrows peer type to `LobbyPeer` and throws if room state is not lobby.
 */
export const requirePeerLobby = (params: {
  peer: Peer;
  context: string;
  reason?: string;
}): LobbyPeer => {
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "lobby",
    targetRoomState: "joined",
    reason: params.reason,
  });
  return params.peer as LobbyPeer;
};

/**
 * Narrows peer type to `JoinedPeer` and throws if room state is not joined.
 */
export const requirePeerJoined = (params: {
  peer: Peer;
  context: string;
  reason?: string;
}): JoinedPeer => {
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "joined",
    reason: params.reason,
  });
  return params.peer as JoinedPeer;
};

/**
 * Narrows peer type to `MediaReadyPeer` and throws until media is ready.
 */
export const requirePeerMediaReady = (params: {
  peer: Peer;
  context: string;
  reason?: string;
}): MediaReadyPeer => {
  const joinedPeer = requirePeerJoined({
    peer: params.peer,
    context: params.context,
    reason: params.reason,
  });
  assertPeerMediaState({
    context: params.context,
    peerId: joinedPeer.id,
    currentRoomState: joinedPeer.roomState,
    currentMediaState: joinedPeer.mediaState,
    expectedRoomState: "joined",
    expectedMediaState: "ready",
    reason: params.reason ?? "peer must complete media setup first",
  });
  return joinedPeer as MediaReadyPeer;
};

/** Session-origin lookup required by origin-to-peer resolution helpers. */
export type PeerStateSessionsPort = {
  getPeerIdByOrigin(originId: Guid): Guid | undefined;
};

/**
 * Resolves and validates one peer from the in-memory peer map.
 */
export const requirePeer = (params: {
  peers: Map<Guid, Peer>;
  peerId: Guid;
  context: string;
  invariantScope?: string;
}): Peer => {
  const peer = requireValue(
    params.peers.get(params.peerId),
    `Missing peer ${params.peerId} on ${params.context}`,
  );
  const invariantScope = params.invariantScope ?? "peerStateMachine";
  assertValidPeerInvariant(peer, `${invariantScope}.${params.context}`);
  return peer;
};

/**
 * Resolves a peer and enforces joined-room preconditions.
 */
export const requireAttachedPeer = (params: {
  peers: Map<Guid, Peer>;
  peerId: Guid;
  context: string;
  invariantScope?: string;
}): JoinedPeer =>
  requirePeerJoined({
    peer: requirePeer({
      peers: params.peers,
      peerId: params.peerId,
      context: params.context,
      invariantScope: params.invariantScope,
    }),
    context: params.context,
    reason: "peer must be joined to a room for this operation",
  });

/**
 * Resolves a peer and enforces media-ready preconditions.
 */
export const requireMediaPeer = (params: {
  peers: Map<Guid, Peer>;
  peerId: Guid;
  context: string;
  invariantScope?: string;
}): MediaReadyPeer =>
  requirePeerMediaReady({
    peer: requireAttachedPeer({
      peers: params.peers,
      peerId: params.peerId,
      context: params.context,
      invariantScope: params.invariantScope,
    }),
    context: params.context,
    reason: "peer must complete media setup first",
  });

/**
 * Applies/reapplies RTP capabilities to a joined peer, preserving invariants.
 */
export const withRtpCapabilities = (params: {
  peer: JoinedPeer;
  rtpCapabilities: RtpCapabilities;
  context: string;
}): MediaReadyPeer => {
  if (params.peer.mediaState === "ready") {
    const updatedPeer: MediaReadyPeer = {
      ...params.peer,
      deviceRTPCapabilities: params.rtpCapabilities,
    };
    assertValidPeerInvariant(
      updatedPeer,
      `${params.context}:withRtpCapabilities:alreadyReady`,
    );
    return updatedPeer;
  }

  return applyPeerEvent({
    peer: params.peer,
    event: {
      type: "mediaReadyReported",
      rtpCapabilities: params.rtpCapabilities,
    },
    context: `${params.context}:withRtpCapabilities`,
  }).updatedPeer as MediaReadyPeer;
};

/**
 * Resolves the owning peer id for a websocket origin/transport id.
 */
export const requirePeerIdByOrigin = (params: {
  sessions: PeerStateSessionsPort;
  originId: Guid;
  context: string;
}): Guid =>
  requireValue(
    params.sessions.getPeerIdByOrigin(params.originId),
    `Missing peer mapping for origin ${params.originId} on ${params.context}`,
  );

/**
 * Resolves media-ready peer from a websocket origin/transport id.
 */
export const requireMediaPeerByOrigin = (params: {
  peers: Map<Guid, Peer>;
  sessions: PeerStateSessionsPort;
  originId: Guid;
  context: string;
  invariantScope?: string;
}): MediaReadyPeer =>
  requireMediaPeer({
    peers: params.peers,
    peerId: requirePeerIdByOrigin({
      sessions: params.sessions,
      originId: params.originId,
      context: params.context,
    }),
    context: params.context,
    invariantScope: params.invariantScope,
  });

/**
 * Validates room-state preconditions and throws a descriptive transition error on mismatch.
 */
export const assertPeerRoomState = (params: {
  context: string;
  peerId: Guid;
  currentRoomState: RoomState;
  currentMediaState: MediaState;
  expectedRoomState: RoomState | RoomState[];
  expectedMediaState?: MediaState | MediaState[];
  targetRoomState?: RoomState;
  reason?: string;
}) => {
  const expectedRoomStates = Array.isArray(params.expectedRoomState)
    ? params.expectedRoomState
    : [params.expectedRoomState];
  if (expectedRoomStates.includes(params.currentRoomState)) {
    return;
  }
  throw new PeerStateError(
    buildStateError({
      context: params.context,
      peerId: params.peerId,
      currentRoomState: params.currentRoomState,
      currentMediaState: params.currentMediaState,
      expectedRoomState: params.expectedRoomState,
      expectedMediaState: params.expectedMediaState,
      targetRoomState: params.targetRoomState,
      reason:
        params.reason ??
        "peer must be in the expected room lifecycle state for this operation",
    }),
  );
};

/**
 * Validates media-state preconditions and throws a descriptive transition error on mismatch.
 */
export const assertPeerMediaState = (params: {
  context: string;
  peerId: Guid;
  currentRoomState: RoomState;
  currentMediaState: MediaState;
  expectedMediaState: MediaState | MediaState[];
  expectedRoomState?: RoomState | RoomState[];
  targetMediaState?: MediaState;
  reason?: string;
}) => {
  const expectedMediaStates = Array.isArray(params.expectedMediaState)
    ? params.expectedMediaState
    : [params.expectedMediaState];
  if (expectedMediaStates.includes(params.currentMediaState)) {
    return;
  }
  throw new PeerStateError(
    buildStateError({
      context: params.context,
      peerId: params.peerId,
      currentRoomState: params.currentRoomState,
      currentMediaState: params.currentMediaState,
      expectedRoomState: params.expectedRoomState,
      expectedMediaState: params.expectedMediaState,
      targetMediaState: params.targetMediaState,
      reason:
        params.reason ??
        "peer must be in the expected media lifecycle state for this operation",
    }),
  );
};

const transitionRoomState = (params: {
  context: string;
  peer: Peer;
  event: RoomEvent;
}) => {
  const nextRoomState =
    ROOM_EVENT_TRANSITIONS[params.peer.roomState][params.event];
  if (nextRoomState !== undefined) {
    return nextRoomState;
  }
  const allowedEvents = Object.keys(
    ROOM_EVENT_TRANSITIONS[params.peer.roomState],
  ).join("|");
  throw new PeerStateError(
    buildStateError({
      context: params.context,
      peerId: params.peer.id,
      currentRoomState: params.peer.roomState,
      currentMediaState: params.peer.mediaState,
      event: params.event,
      reason: `invalid room event; allowed events are ${allowedEvents}`,
    }),
  );
};

const transitionMediaState = (params: {
  context: string;
  peer: Peer;
  event: MediaEvent;
}) => {
  const nextMediaState =
    MEDIA_EVENT_TRANSITIONS[params.peer.mediaState][params.event];
  if (nextMediaState !== undefined) {
    return nextMediaState;
  }
  const allowedEvents = Object.keys(
    MEDIA_EVENT_TRANSITIONS[params.peer.mediaState],
  ).join("|");
  throw new PeerStateError(
    buildStateError({
      context: params.context,
      peerId: params.peer.id,
      currentRoomState: params.peer.roomState,
      currentMediaState: params.peer.mediaState,
      event: params.event,
      reason: `invalid media event; allowed events are ${allowedEvents}`,
    }),
  );
};

/**
 * Applies room join transition (`lobby -> joined`) and initializes room/server bindings.
 */
export const transitionPeerToJoined = (params: {
  peer: Peer;
  room: string;
  ingress: Guid;
  egress: Guid;
  context: string;
}): AttachedPeer => {
  assertValidPeerInvariant(params.peer, `${params.context}:before`);
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "lobby",
    targetRoomState: "joined",
  });
  const nextRoomState = transitionRoomState({
    context: params.context,
    peer: params.peer,
    event: "joinRequested",
  });
  if (nextRoomState !== "joined") {
    throw new PeerStateError(
      buildStateError({
        context: params.context,
        peerId: params.peer.id,
        currentRoomState: params.peer.roomState,
        currentMediaState: params.peer.mediaState,
        targetRoomState: "joined",
        event: "joinRequested",
        reason: "room transition did not produce joined state",
      }),
    );
  }
  const lobbyPeer = params.peer as LobbyPeer;
  const joinedPeer: AttachedPeer = {
    ...lobbyPeer,
    roomState: "joined",
    mediaState: "none",
    room: params.room,
    ingress: params.ingress,
    egress: params.egress,
    deviceRTPCapabilities: undefined,
    isLobby: false,
  };
  assertValidPeerInvariant(joinedPeer, `${params.context}:after`);
  return joinedPeer;
};

/**
 * Applies media-ready transition (`none|failed -> ready`) and stores RTP capabilities.
 */
export const transitionPeerToMediaReady = (params: {
  peer: Peer;
  rtpCapabilities: RtpCapabilities;
  context: string;
}): MediaReadyPeer => {
  assertValidPeerInvariant(params.peer, `${params.context}:before`);
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "joined",
    reason: "peer must be joined to a room before becoming media-ready",
  });
  const nextMediaState = transitionMediaState({
    context: params.context,
    peer: params.peer,
    event: "mediaReadyReported",
  });
  if (nextMediaState !== "ready") {
    throw new PeerStateError(
      buildStateError({
        context: params.context,
        peerId: params.peer.id,
        currentRoomState: params.peer.roomState,
        currentMediaState: params.peer.mediaState,
        targetMediaState: "ready",
        event: "mediaReadyReported",
        reason: "media transition did not produce ready state",
      }),
    );
  }
  const joinedPeer = params.peer as JoinedPeer;
  const mediaReadyPeer: MediaReadyPeer = {
    ...joinedPeer,
    roomState: "joined",
    mediaState: "ready",
    deviceRTPCapabilities: params.rtpCapabilities,
  };
  assertValidPeerInvariant(mediaReadyPeer, `${params.context}:after`);
  return mediaReadyPeer;
};

/**
 * Applies media-failed transition and clears RTP capability bindings.
 */
export const transitionPeerToMediaFailed = (params: {
  peer: Peer;
  context: string;
}): MediaFailedPeer => {
  assertValidPeerInvariant(params.peer, `${params.context}:before`);
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "joined",
    reason: "peer must be joined to a room before recording media failure",
  });
  const nextMediaState = transitionMediaState({
    context: params.context,
    peer: params.peer,
    event: "mediaFailedReported",
  });
  if (nextMediaState !== "failed") {
    throw new PeerStateError(
      buildStateError({
        context: params.context,
        peerId: params.peer.id,
        currentRoomState: params.peer.roomState,
        currentMediaState: params.peer.mediaState,
        targetMediaState: "failed",
        event: "mediaFailedReported",
        reason: "media transition did not produce failed state",
      }),
    );
  }
  const joinedPeer = params.peer as JoinedPeer;
  const failedPeer: MediaFailedPeer = {
    ...joinedPeer,
    roomState: "joined",
    mediaState: "failed",
    deviceRTPCapabilities: undefined,
  };
  assertValidPeerInvariant(failedPeer, `${params.context}:after`);
  return failedPeer;
};

/**
 * Clears media-ready/failed state back to `none` while keeping room attachment.
 */
export const clearPeerMediaState = (params: {
  peer: Peer;
  context: string;
}): AttachedPeer => {
  assertValidPeerInvariant(params.peer, `${params.context}:before`);
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "joined",
  });
  const nextMediaState = transitionMediaState({
    context: params.context,
    peer: params.peer,
    event: "mediaCleared",
  });
  if (nextMediaState !== "none") {
    throw new PeerStateError(
      buildStateError({
        context: params.context,
        peerId: params.peer.id,
        currentRoomState: params.peer.roomState,
        currentMediaState: params.peer.mediaState,
        targetMediaState: "none",
        event: "mediaCleared",
        reason: "media transition did not produce none state",
      }),
    );
  }
  const joinedPeer = params.peer as JoinedPeer;
  const clearedPeer: AttachedPeer = {
    ...joinedPeer,
    roomState: "joined",
    mediaState: "none",
    deviceRTPCapabilities: undefined,
  };
  assertValidPeerInvariant(clearedPeer, `${params.context}:after`);
  return clearedPeer;
};

/**
 * Applies room leave transition (`joined -> lobby`) and clears room/media bindings.
 */
export const transitionPeerToLobby = (params: {
  peer: Peer;
  context: string;
}): LobbyPeer => {
  assertValidPeerInvariant(params.peer, `${params.context}:before`);
  assertPeerRoomState({
    context: params.context,
    peerId: params.peer.id,
    currentRoomState: params.peer.roomState,
    currentMediaState: params.peer.mediaState,
    expectedRoomState: "joined",
    reason: "peer is not joined to a room",
  });
  const nextRoomState = transitionRoomState({
    context: params.context,
    peer: params.peer,
    event: "leaveRequested",
  });
  if (nextRoomState !== "lobby") {
    throw new PeerStateError(
      buildStateError({
        context: params.context,
        peerId: params.peer.id,
        currentRoomState: params.peer.roomState,
        currentMediaState: params.peer.mediaState,
        targetRoomState: "lobby",
        event: "leaveRequested",
        reason: "room transition did not produce lobby state",
      }),
    );
  }
  const joinedPeer = params.peer as JoinedPeer;
  const lobbyPeer: LobbyPeer = {
    ...joinedPeer,
    roomState: "lobby",
    mediaState: "none",
    room: undefined,
    ingress: undefined,
    egress: undefined,
    deviceRTPCapabilities: undefined,
    isLobby: true,
    isSpectator: false,
    isParticipant: false,
  };
  assertValidPeerInvariant(lobbyPeer, `${params.context}:after`);
  return lobbyPeer;
};

/**
 * Returns whether an event is valid for the peer's current room/media state.
 */
export const canApplyPeerEvent = (peer: Peer, eventType: PeerEvent["type"]) => {
  switch (eventType) {
    case "joinRequested":
    case "leaveRequested":
    case "peerDisconnected":
      return ROOM_EVENT_TRANSITIONS[peer.roomState][eventType] !== undefined;
    case "mediaReadyReported":
    case "mediaCleared":
    case "mediaFailedReported":
    case "mediaRecoveryRequested":
      return (
        peer.roomState === "joined" &&
        MEDIA_EVENT_TRANSITIONS[peer.mediaState][eventType] !== undefined
      );
    default:
      return assertNever(eventType, "canApplyPeerEvent");
  }
};

/**
 * Reducer entry point for peer lifecycle events.
 *
 * Returns the updated peer plus side-effect descriptors (currently empty; reserved for future use).
 */
export const applyPeerEvent = (params: {
  peer: Peer;
  event: PeerEvent;
  context: string;
}): PeerReducerResult => {
  switch (params.event.type) {
    case "joinRequested":
      return {
        updatedPeer: transitionPeerToJoined({
          peer: params.peer,
          room: params.event.room,
          ingress: params.event.ingress,
          egress: params.event.egress,
          context: params.context,
        }),
        effects: [],
      };
    case "leaveRequested":
    case "peerDisconnected":
      if (params.peer.roomState === "lobby") {
        assertValidPeerInvariant(params.peer, `${params.context}:noop`);
        return { updatedPeer: params.peer, effects: [] };
      }
      return {
        updatedPeer: transitionPeerToLobby({
          peer: params.peer,
          context: params.context,
        }),
        effects: [],
      };
    case "mediaReadyReported":
      return {
        updatedPeer: transitionPeerToMediaReady({
          peer: params.peer,
          rtpCapabilities: params.event.rtpCapabilities,
          context: params.context,
        }),
        effects: [],
      };
    case "mediaFailedReported":
      return {
        updatedPeer: transitionPeerToMediaFailed({
          peer: params.peer,
          context: params.context,
        }),
        effects: [],
      };
    case "mediaCleared":
    case "mediaRecoveryRequested":
      return {
        updatedPeer: clearPeerMediaState({
          peer: params.peer,
          context: params.context,
        }),
        effects: [],
      };
    default:
      return assertNever(params.event, "applyPeerEvent");
  }
};

/**
 * Concern-grouped exports for clearer module navigation.
 *
 * Existing named exports remain the primary API; these groups provide
 * a readable map of the state-machine surface by concern.
 */
export const PeerTransportBindings = {
  bindPeerTransport,
  unbindPeerTransportForServer,
  unbindPeerTransportById,
  clearPeerRuntimeBindings,
} as const;

/**
 * Grouped guard helpers for room/media precondition enforcement.
 */
export const PeerStateGuards = {
  buildPeerFailure,
  assertValidPeerInvariant,
  assertPeerRoomState,
  assertPeerMediaState,
  requirePeerLobby,
  requirePeerJoined,
  requirePeerMediaReady,
} as const;

/**
 * Grouped query helpers for peer lifecycle state checks.
 */
export const PeerStateQueries = {
  isPeerJoined,
  isPeerMediaReady,
  canApplyPeerEvent,
  describeJoinRequestBlockReason,
} as const;

/**
 * Grouped transition/reducer helpers for peer lifecycle state updates.
 */
export const PeerStateTransitions = {
  transitionPeerToJoined,
  transitionPeerToLobby,
  transitionPeerToMediaReady,
  transitionPeerToMediaFailed,
  clearPeerMediaState,
  applyPeerEvent,
} as const;
