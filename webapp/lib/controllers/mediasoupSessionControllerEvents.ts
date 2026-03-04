/**
 * @file Shared controller event handler types.
 * Keeps the signaling adapter + controller aligned without circular imports.
 * @internal
 */
import type { AppData } from "mediasoup-client/lib/types";
import type { SystemStatus } from "../../../types/wsRelay";

/** @internal */
export type PeerId = string;

/** @internal */
export type IdentityHandler = (peerId: PeerId) => void;
/** @internal */
export type IceHandler = () =>
  | Promise<RTCIceServer[]>
  | RTCIceServer[]
  | void
  | undefined;
/** @internal */
export type UplinkStateHandler = (connected: boolean) => void;
/** @internal */
export type UplinkReadyHandler = (ready: boolean) => void;
/** @internal */
export type DownlinkStateHandler = (connected: boolean) => void;
/** @internal */
export type PeerVideoHandler = (
  peerId: PeerId,
  track: MediaStreamTrack,
  appData: AppData | undefined,
) => void;
/** @internal */
export type PeerAudioHandler = (
  peerId: PeerId,
  track: MediaStreamTrack,
  appData: AppData | undefined,
) => void;
/** @internal */
export type PeerScreenVideoHandler = PeerVideoHandler;
/** @internal */
export type PeerScreenAudioHandler = PeerAudioHandler;
/** @internal */
export type LocalVideoHandler = (
  track: MediaStreamTrack,
  appData: AppData | undefined,
) => void;
/** @internal */
export type LocalAudioHandler = (
  track: MediaStreamTrack,
  appData: AppData | undefined,
) => void;
/** @internal */
/** @internal */
export type LocalMediaClosedHandler = (
  kind: "audio" | "video",
  appData: AppData | undefined,
) => void;
/** @internal */
export type PeerMediaClosedHandler = (
  peerId: PeerId,
  kind: "audio" | "video",
  appData: AppData | undefined,
) => void;
/** @internal */
export type PeerDisconnectedHandler = (
  peerId: PeerId,
  room?: string,
) => void;
/** @internal */
export type PeerConnectedHandler = (peerId: PeerId, room: string) => void;
/** @internal */
export type RoomAttachedHandler = (peerId: PeerId, room: string) => void;
/** @internal */
export type RoomDetachedHandler = (peerId: PeerId, room: string) => void;
/** @internal */
export type SystemStatusHandler = (data: SystemStatus) => void;
