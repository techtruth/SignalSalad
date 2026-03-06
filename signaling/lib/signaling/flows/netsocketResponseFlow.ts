/**
 * Netsocket callback-to-websocket mapping helpers.
 *
 * These functions translate media-server callback payloads into signaling-side
 * state updates and websocket responses.
 *
 * @remarks
 * ```mermaid
 * flowchart TD
 *   IN[callback type] --> SW[handleNetsocketResponse switch]
 *   SW --> MAP[mapping helper]
 *   MAP --> WS[websocket response]
 * ```
 */
import type {
  Guid,
  MediaReadyPeer,
  Peer,
} from "../../../../types/baseTypes.d.ts";
import type { ProducerRegistry } from "../../core/peer/producerRegistry.js";
import type { PeerSessions } from "../../core/peer/peerSessions.js";
import type { MediaInboundMessageMap } from "../../protocol/signalingIoValidation.js";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import {
  buildJoinedRoomMessage,
  buildMediaAnnouncementMessage,
  buildProducedMediaMessage,
} from "../../protocol/websocketResponseBuilders.js";

/** Typed payload alias for `createdConsumer` netsocket callbacks. */
export type CreatedConsumerResponse = MediaInboundMessageMap["createdConsumer"];
/** Typed payload alias for `createdRouterGroup` netsocket callbacks. */
export type CreatedRouterGroupResponse =
  MediaInboundMessageMap["createdRouterGroup"];
/** Typed payload alias for `createdMediaProducer` netsocket callbacks. */
export type CreatedMediaProducerResponse =
  MediaInboundMessageMap["createdMediaProducer"];
/** Discriminator for netsocket callbacks that emit websocket-facing responses. */
export type NetsocketResponseType =
  | "createdConsumer"
  | "createdRouterGroup"
  | "createdMediaProducer";

/**
 * Maps `createdConsumer` media-node responses to websocket media announcements.
 *
 * @param params Mapping dependencies + callback payload.
 * @throws {Error} When transport -> peer mapping or peer lookup invariants fail.
 */
export const handleCreatedConsumerResponse = (params: {
  consumers: CreatedConsumerResponse;
  sessions: PeerSessions;
  requireValue: <T>(value: T | undefined | null, message: string) => T;
  requirePeer: (peerId: Guid, context: string) => Peer;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
}) => {
  const {
    consumers,
    sessions,
    requireValue,
    requirePeer,
    sendWebsocketMessage,
  } = params;

  for (const [transportId, consumerOptionsArray] of Object.entries(consumers)) {
    const peerId = requireValue(
      sessions.getPeerIdByTransport(transportId as Guid, "egress"),
      `Missing peer mapping for consumer transport ${transportId}`,
    );
    const consumingPeer = requirePeer(peerId, "createdConsumer");
    const mediaAnnouncement = buildMediaAnnouncementMessage(
      transportId as Guid,
      consumerOptionsArray,
    );
    sendWebsocketMessage(
      consumingPeer.transportSignal,
      "mediaAnnouncement",
      mediaAnnouncement,
    );
  }
};

/**
 * Maps `createdRouterGroup` media-node responses to websocket joined-room payloads.
 *
 * @param params Callback payload + websocket messaging adapter.
 * @throws {Error} When websocket delivery fails.
 */
export const handleCreatedRouterGroupResponse = (params: {
  message: CreatedRouterGroupResponse;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
}) => {
  const { message, sendWebsocketMessage } = params;
  const joinedRoomMessage = buildJoinedRoomMessage(message);
  sendWebsocketMessage(message.origin, "joinedRoom", joinedRoomMessage);
};

/**
 * Maps `createdMediaProducer` media-node responses into producer registry updates
 * and websocket producer acknowledgements.
 *
 * @param params Mapping dependencies + callback payload.
 * @throws {Error} When producer owner state is no longer valid or websocket send fails.
 */
export const handleCreatedMediaProducerResponse = (params: {
  message: CreatedMediaProducerResponse;
  requireMediaPeerByOrigin: (originId: Guid, context: string) => MediaReadyPeer;
  producers: ProducerRegistry;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
}) => {
  const { message, requireMediaPeerByOrigin, producers, sendWebsocketMessage } =
    params;

  const owner = requireMediaPeerByOrigin(
    message.originId,
    "createdMediaProducer",
  );
  producers.recordProducer(
    message.producerId,
    owner.id,
    owner.room,
    message.kind,
    owner.ingress,
  );
  const producedMediaMessage = buildProducedMediaMessage({
    producerId: message.producerId,
    appData: message.appData,
    requestId: message.requestId,
  });
  sendWebsocketMessage(message.originId, "producedMedia", producedMediaMessage);
};

/**
 * Explicit router for websocket-facing netsocket callback handling.
 *
 * This makes callback input/output flow visible in one switch:
 * callback type -> mapping function -> websocket output.
 */
export const handleNetsocketResponse = (
  params:
    | {
        type: "createdConsumer";
        consumers: CreatedConsumerResponse;
        sessions: PeerSessions;
        requireValue: <T>(value: T | undefined | null, message: string) => T;
        requirePeer: (peerId: Guid, context: string) => Peer;
        sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
      }
    | {
        type: "createdRouterGroup";
        message: CreatedRouterGroupResponse;
        sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
      }
    | {
        type: "createdMediaProducer";
        message: CreatedMediaProducerResponse;
        requireMediaPeerByOrigin: (
          originId: Guid,
          context: string,
        ) => MediaReadyPeer;
        producers: ProducerRegistry;
        sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
      },
) => {
  switch (params.type) {
    case "createdConsumer":
      return handleCreatedConsumerResponse({
        consumers: params.consumers,
        sessions: params.sessions,
        requireValue: params.requireValue,
        requirePeer: params.requirePeer,
        sendWebsocketMessage: params.sendWebsocketMessage,
      });
    case "createdRouterGroup":
      return handleCreatedRouterGroupResponse({
        message: params.message,
        sendWebsocketMessage: params.sendWebsocketMessage,
      });
    case "createdMediaProducer":
      return handleCreatedMediaProducerResponse({
        message: params.message,
        requireMediaPeerByOrigin: params.requireMediaPeerByOrigin,
        producers: params.producers,
        sendWebsocketMessage: params.sendWebsocketMessage,
      });
    default: {
      const unreachableType: never = params;
      return unreachableType;
    }
  }
};
