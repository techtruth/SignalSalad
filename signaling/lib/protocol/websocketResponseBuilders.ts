import type { Guid } from "../../../types/baseTypes.d.ts";
import type {
  CreatedMediaConsumer,
  CreatedMediaProducer,
  CreatedRouterGroup,
} from "../../../types/nsRelay.d.ts";
import type { WsMessageMap } from "./signalingIoValidation.js";

/** Helper alias for typed websocket response payload extraction. */
type WsResponsePayload<T extends keyof WsMessageMap> = WsMessageMap[T];

/**
 * Shared websocket payload builders.
 *
 * These helpers centralize response message shaping while keeping send ownership
 * in domain modules.
 */

/**
 * Builds websocket `identity` payload.
 *
 * @param peerId Assigned peer id.
 * @param originId Origin websocket id.
 * @param region Resolved regional affinity label.
 * @returns Typed `identity` message payload.
 */
export const buildIdentityMessage = (
  peerId: Guid,
  originId: Guid,
  region: string,
): WsResponsePayload<"identity"> => ({
  peerId,
  originId,
  region,
});

/**
 * Builds websocket `peerConnected` payload.
 *
 * @param peerId Connected peer id.
 * @param room Room id where peer is connected.
 * @returns Typed `peerConnected` message payload.
 */
export const buildPeerConnectedMessage = (
  peerId: Guid,
  room: string,
): WsResponsePayload<"peerConnected"> => ({
  peerId,
  room,
});

/**
 * Builds websocket `peerDisconnected` payload.
 *
 * @param peerId Disconnected peer id.
 * @param room Optional room id when disconnect is room-scoped.
 * @returns Typed `peerDisconnected` message payload.
 */
export const buildPeerDisconnectedMessage = (
  peerId: Guid,
  room?: string,
): WsResponsePayload<"peerDisconnected"> =>
  room === undefined
    ? { peerId }
    : {
        peerId,
        room,
      };

/**
 * Builds websocket `roomAttached` payload.
 *
 * @param params Room attachment metadata.
 * @returns Typed `roomAttached` message payload.
 */
export const buildRoomAttachedMessage = (params: {
  peerId: Guid;
  room: string;
  egressServers?: Guid[];
  roomPeers?: Guid[];
}): WsResponsePayload<"roomAttached"> => ({
  peerId: params.peerId,
  room: params.room,
  egressServers: params.egressServers,
  roomPeers: params.roomPeers,
});

/**
 * Builds websocket `roomDetached` payload.
 *
 * @param peerId Peer leaving room.
 * @param room Room id detached from peer.
 * @returns Typed `roomDetached` message payload.
 */
export const buildRoomDetachedMessage = (
  peerId: Guid,
  room: string,
): WsResponsePayload<"roomDetached"> => ({
  peerId,
  room,
});

/**
 * Builds websocket `roomEgressReady` payload.
 *
 * @param room Room id whose egress set is ready.
 * @param egressServers Active egress server ids for room.
 * @returns Typed `roomEgressReady` message payload.
 */
export const buildRoomEgressReadyMessage = (
  room: string,
  egressServers: Guid[],
): WsResponsePayload<"roomEgressReady"> => ({
  room,
  egressServers,
});

/** Builds websocket `connectedIngress` payload. */
export const buildConnectedIngressMessage =
  (): WsResponsePayload<"connectedIngress"> => ({});

/** Builds websocket `connectedEgress` payload. */
export const buildConnectedEgressMessage =
  (): WsResponsePayload<"connectedEgress"> => ({});

/**
 * Builds websocket `peerMuteRequested` payload.
 *
 * @param requesterPeerId Requesting peer id.
 * @param muted Requested mute state.
 * @returns Typed `peerMuteRequested` message payload.
 */
export const buildPeerMuteRequestedMessage = (
  requesterPeerId: Guid,
  muted: boolean,
): WsResponsePayload<"peerMuteRequested"> => ({
  requesterPeerId,
  muted,
});

/**
 * Builds websocket `producerClosed` payload.
 *
 * @param originId Origin websocket id.
 * @param producerId Closed producer id.
 * @param mediaType Producer media type label.
 * @returns Typed `producerClosed` message payload.
 */
export const buildProducerClosedMessage = (
  originId: Guid,
  producerId: Guid,
  mediaType: string,
): WsResponsePayload<"producerClosed"> => ({
  originId,
  producerId,
  mediaType,
});

/**
 * Builds websocket `joinedRoom` payload from router-group callback.
 *
 * @param message Media callback payload.
 * @returns Typed `joinedRoom` message payload.
 */
export const buildJoinedRoomMessage = (
  message: CreatedRouterGroup,
): WsResponsePayload<"joinedRoom"> => ({
  roomRTPCapabilities: message.roomRTPCapabilities,
  room: message.room,
  serverId: message.serverId,
  mode: message.mode,
});

/**
 * Builds websocket `producedMedia` payload from producer callback metadata.
 *
 * @param params Producer-created callback subset.
 * @returns Typed `producedMedia` message payload.
 */
export const buildProducedMediaMessage = (
  params: Pick<CreatedMediaProducer, "producerId" | "appData" | "requestId">,
): WsResponsePayload<"producedMedia"> => ({
  id: params.producerId as Guid,
  appData: params.appData,
  requestId: params.requestId,
});

/**
 * Builds websocket `mediaAnnouncement` payload from consumer callback entries.
 *
 * @param transportId Egress transport id receiving consumer entries.
 * @param consumerOptionsArray Consumer options emitted by media server.
 * @returns Typed `mediaAnnouncement` message payload.
 */
export const buildMediaAnnouncementMessage = (
  transportId: Guid,
  consumerOptionsArray: CreatedMediaConsumer[string],
): WsResponsePayload<"mediaAnnouncement"> =>
  consumerOptionsArray.map((consumerOptions) => ({
    producerPeerId: consumerOptions.producerPeerId as Guid,
    transportId,
    id: consumerOptions.id as Guid,
    producerId: consumerOptions.producerId as Guid,
    kind: consumerOptions.kind,
    rtpParameters: consumerOptions.rtpParameters,
    appData: consumerOptions.appData,
  }));

/**
 * Builds websocket `error` payload.
 *
 * @param error Stable protocol error code.
 * @param detail Optional human-readable detail.
 * @returns Typed websocket `error` payload.
 */
export const buildWebsocketErrorMessage = (
  error: string,
  detail?: string,
): WsResponsePayload<"error"> =>
  detail === undefined ? { error } : { error, detail };
