import type { RtpCapabilities } from "mediasoup/types";

// general types
export type Guid = string;

// Peer lifecycle modeled as orthogonal state axes.
export type RoomState = "lobby" | "joined";
export type MediaState = "none" | "ready" | "failed";

export type PeerBase = {
  id: Guid;
  transportSignal: Guid;
  transportIngress: { [key: string]: string };
  transportEgress: { [key: string]: string };
  region: string;
  isLobby: boolean;
  isParticipant: boolean;
  isSpectator: boolean;
  mediaProducers: Partial<Record<"audio" | "video", Guid[]>>;
  roomState: RoomState;
  mediaState: MediaState;
};

export type LobbyPeer = PeerBase & {
  roomState: "lobby";
  mediaState: "none";
  room: undefined;
  ingress: undefined;
  egress: undefined;
  deviceRTPCapabilities: undefined;
};

export type AttachedPeer = PeerBase & {
  roomState: "joined";
  mediaState: "none";
  room: string;
  ingress: Guid;
  egress: Guid;
  deviceRTPCapabilities: undefined;
};

export type MediaReadyPeer = PeerBase & {
  roomState: "joined";
  mediaState: "ready";
  room: string;
  ingress: Guid;
  egress: Guid;
  deviceRTPCapabilities: RtpCapabilities;
};

export type MediaFailedPeer = PeerBase & {
  roomState: "joined";
  mediaState: "failed";
  room: string;
  ingress: Guid;
  egress: Guid;
  deviceRTPCapabilities: undefined;
};

export type JoinedPeer = AttachedPeer | MediaReadyPeer | MediaFailedPeer;

export type Peer = LobbyPeer | JoinedPeer;

export type Peers = Map<Guid, Peer>;

export interface Room {
  ingress: string[];
  egress: string[];
}

export type Rooms = Map<string, Room>;
