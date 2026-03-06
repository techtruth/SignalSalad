/**
 * Runtime shape validation for websocket and netsocket I/O.
 *
 * This module is the protocol boundary gate: only payloads that satisfy these
 * guards should reach signaling/core orchestration logic.
 */
import type { Guid } from "../../../types/baseTypes.d.ts";
import type {
  BidirectionalSignalWrapper as BidirectionalMediaSignalWrapper,
  NsInboundMessageMap,
  NsInboundPayload,
  NsOutboundMessageMap,
  NsOutboundPayload,
} from "../../../types/nsRelay.d.ts";
import type {
  RequestMessage as UserRequestMessage,
  SystemDiagnosticEvent,
  WsRequestMessageMap,
  WsResponseMessageMap,
} from "../../../types/wsRelay.d.ts";

/**
 * Runtime payload/type guards for signaling I/O boundaries.
 *
 * These helpers prevent malformed external payloads from entering the core
 * state/dispatch logic and keep message families explicit.
 */
/** Outbound netsocket payload map type alias. */
export type MediaOutboundPayload = NsOutboundPayload;
/** Inbound netsocket payload map type alias. */
export type MediaInboundPayload = NsInboundPayload;
/** Outbound websocket message map type alias. */
export type WsMessageMap = WsResponseMessageMap;
/** Inbound websocket request map type alias. */
export type WsRequestMap = WsRequestMessageMap;
/** Outbound netsocket message map type alias. */
export type NsMessageMap = NsOutboundMessageMap;
/** Inbound netsocket message map type alias. */
export type MediaInboundMessageMap = NsInboundMessageMap;
/** Valid node ids in netsocket signal wrappers. */
export type NodeId = Guid | "signaling";
/** Shared diagnostic event shape without timestamp assignment. */
export type SignalingDiagnosticEvent = Omit<SystemDiagnosticEvent, "at">;

type UnknownRecord = Record<string, unknown>;

/** Narrowing helper for plain object-like values. */
const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null;
/** Narrowing helper for string values. */
const isString = (value: unknown): value is string => typeof value === "string";
/** Narrowing helper for finite numeric values. */
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
/** Narrowing helper for boolean values. */
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
/** Narrowing helper for string-valued records. */
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every(isString);
/** Narrowing helper for signaling direction enum. */
const isDirection = (value: unknown): value is "ingress" | "egress" =>
  value === "ingress" || value === "egress";
/** Narrowing helper for media kind enum. */
const isMediaKind = (value: unknown): value is "audio" | "video" =>
  value === "audio" || value === "video";
/** Narrowing helper for supported diagnostic categories. */
const isDiagnosticCategory = (
  value: unknown,
): value is
  | "websocketRequest"
  | "netsocketCommand"
  | "producerLifecycle"
  | "transportLifecycle"
  | "mediaServerLifecycle" =>
  value === "websocketRequest" ||
  value === "netsocketCommand" ||
  value === "producerLifecycle" ||
  value === "transportLifecycle" ||
  value === "mediaServerLifecycle";
/** Narrowing helper for homogeneous string arrays. */
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);
/** Narrowing helper for homogeneous numeric arrays. */
const isNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every(isNumber);

/** Ensures message-like object has discriminator `type` and `message` payload. */
const hasTypeAndMessage = (
  value: unknown,
): value is { type: string; message: unknown } =>
  isRecord(value) && typeof value.type === "string" && "message" in value;

type UserRequestPayloadValidator = (message: UnknownRecord) => boolean;
type MediaInboundPayloadValidator = (message: UnknownRecord) => boolean;

/** Validators for room/session-oriented websocket user requests. */
const USER_ROOM_VALIDATORS = {
  requestIdentity: (message) => isString(message.region),
  joinRoom: (message) => isString(message.peerId) && isString(message.room),
  disconnectPeerWebsocket: (message) =>
    isNumber(message.code) && isString(message.transport),
  leaveRoom: (message) => isString(message.peerId) && isString(message.room),
  mutePeer: (message) =>
    isString(message.requestingPeer) &&
    isString(message.targetPeer) &&
    (message.scope === "client" || message.scope === "server") &&
    isBoolean(message.muted),
  requestSystemStatus: (_message) => true,
} satisfies Partial<
  Record<UserRequestMessage["type"], UserRequestPayloadValidator>
>;

/** Validators for media/transport-oriented websocket user requests. */
const USER_MEDIA_VALIDATORS = {
  createIngress: (message) =>
    isString(message.peerId) &&
    isString(message.room) &&
    isRecord(message.numStreams) &&
    isNumber(message.numStreams.OS) &&
    isNumber(message.numStreams.MIS) &&
    isRecord(message.rtpCapabilities),
  createEgress: (message) =>
    isString(message.peerId) &&
    isString(message.room) &&
    isRecord(message.numStreams) &&
    isNumber(message.numStreams.OS) &&
    isNumber(message.numStreams.MIS) &&
    isRecord(message.rtpCapabilities) &&
    isString(message.serverId),
  connectIngress: (message) =>
    isString(message.peerId) &&
    isString(message.transportId) &&
    isRecord(message.dtlsParameters),
  connectEgress: (message) =>
    isString(message.peerId) &&
    isString(message.transportId) &&
    isRecord(message.dtlsParameters) &&
    isString(message.serverId),
  produceMedia: (message) =>
    isString(message.producingPeer) &&
    isString(message.transportId) &&
    isRecord(message.producerOptions) &&
    isMediaKind(message.producerOptions.kind) &&
    isString(message.requestId),
  producerClose: (message) =>
    isString(message.originId) &&
    isString(message.producerId) &&
    isString(message.mediaType),
  requestRoomAudio: (message) => isString(message.requestingPeer),
  requestRoomVideo: (message) => isString(message.requestingPeer),
} satisfies Partial<
  Record<UserRequestMessage["type"], UserRequestPayloadValidator>
>;

/** Complete websocket user-request validator lookup by request `type`. */
const USER_REQUEST_VALIDATORS = {
  ...USER_ROOM_VALIDATORS,
  ...USER_MEDIA_VALIDATORS,
} satisfies Record<UserRequestMessage["type"], UserRequestPayloadValidator>;

/** Validators for signaling-originated media request payloads. */
const MEDIA_REQUEST_VALIDATORS = {
  createRouterGroup: (message) =>
    isString(message.room) && isString(message.origin),
  dumpRouterGroup: (message) =>
    isString(message.room) && isString(message.origin),
  destroyRouterGroup: (message) => isString(message.routerNetwork),
  createWebRTCIngressTransport: (message) =>
    isString(message.originId) &&
    isRecord(message.sctpOptions) &&
    isString(message.routerNetwork),
  createWebRTCEgressTransport: (message) =>
    isString(message.originId) &&
    isRecord(message.sctpOptions) &&
    isString(message.routerNetwork),
  connectWebRTCIngressTransport: (message) =>
    isString(message.originId) &&
    isString(message.transportId) &&
    isRecord(message.dtlsParameters),
  connectWebRTCEgressTransport: (message) =>
    isString(message.originId) &&
    isString(message.transportId) &&
    isRecord(message.dtlsParameters),
  createMediaProducer: (message) =>
    isString(message.originId) &&
    isString(message.transportId) &&
    isRecord(message.producerOptions) &&
    isString(message.routerNetwork) &&
    isRecord(message.rtpCapabilities) &&
    isString(message.egress) &&
    isString(message.requestId),
  consumeVideo: (message) =>
    isString(message.consumerPeer) &&
    isStringArray(message.producerPeers) &&
    isString(message.room) &&
    isRecord(message.rtpCaps),
  consumeAudio: (message) =>
    isString(message.consumerPeer) &&
    isStringArray(message.producerPeers) &&
    isString(message.room) &&
    isRecord(message.rtpCaps),
  producerClose: (message) =>
    isString(message.peerId) &&
    isString(message.producerId) &&
    isString(message.mediaType),
  setProducerPaused: (message) =>
    isString(message.producerId) && isBoolean(message.paused),
  createConsumer: (message) =>
    isMediaKind(message.kind) &&
    isStringArray(message.consumerTransports) &&
    Array.isArray(message.producerIds) &&
    isString(message.room) &&
    isRecord(message.rtpCaps),
  teardownPeerSession: (message) =>
    isString(message.originId) &&
    isString(message.peerId) &&
    isString(message.operationId) &&
    (message.mode === "leaving" || message.mode === "closing") &&
    isStringArray(message.transportIds) &&
    isStringArray(message.producerIds),
} satisfies Partial<
  Record<MediaInboundPayload["type"], MediaInboundPayloadValidator>
>;

/** Validators for media-server callback/response payloads. */
const MEDIA_RESPONSE_VALIDATORS = {
  createdRouterGroup: (message) =>
    isRecord(message.roomRTPCapabilities) &&
    isString(message.room) &&
    isString(message.serverId) &&
    isDirection(message.mode) &&
    isString(message.origin),
  routerDump: (message) =>
    isString(message.origin) &&
    isString(message.room) &&
    isString(message.serverId) &&
    isDirection(message.mode) &&
    Array.isArray(message.routers) &&
    Array.isArray(message.pipeTransports),
  createdWebRTCIngressTransport: (message) =>
    isString(message.originId) &&
    isString(message.transportId) &&
    isRecord(message.iceParameters) &&
    Array.isArray(message.iceCandidates) &&
    isRecord(message.dtlsParameters),
  createdWebRTCEgressTransport: (message) =>
    isString(message.originId) &&
    isString(message.transportId) &&
    isRecord(message.iceParameters) &&
    Array.isArray(message.iceCandidates) &&
    isRecord(message.dtlsParameters),
  connectedWebRTCIngressTransport: (message) => isString(message.originId),
  connectedWebRTCEgressTransport: (message) => isString(message.originId),
  createdMediaProducer: (message) =>
    isString(message.originId) &&
    isString(message.producerId) &&
    isMediaKind(message.kind) &&
    isRecord(message.rtpParameters) &&
    isRecord(message.appData) &&
    isString(message.requestId),
  createdConsumer: (message) =>
    Object.values(message).every((consumerEntries) => {
      if (!Array.isArray(consumerEntries)) {
        return false;
      }
      return consumerEntries.every((entry) => {
        if (!isRecord(entry)) {
          return false;
        }
        return (
          isString(entry.id) &&
          isString(entry.producerId) &&
          isString(entry.producerPeerId) &&
          isMediaKind(entry.kind) &&
          isRecord(entry.rtpParameters) &&
          isRecord(entry.appData)
        );
      });
    }),
  producerClosed: (message) =>
    isString(message.originId) &&
    isString(message.producerId) &&
    isString(message.mediaType),
  disconnectedWebRTCTransport: (message) =>
    isString(message.transportId) &&
    (message.originId === undefined || isString(message.originId)) &&
    isDirection(message.direction),
} satisfies Partial<
  Record<MediaInboundPayload["type"], MediaInboundPayloadValidator>
>;

/** Validators for ingress<->egress relay handshake payloads. */
const MEDIA_RELAY_VALIDATORS = {
  initializedNetworkRelay: (message) =>
    isString(message.originId) &&
    isString(message.routerNetwork) &&
    isString(message.producerId) &&
    isRecord(message.consumerOptions) &&
    isBoolean(message.createNetworkPipeTransport) &&
    isString(message.ingressIp) &&
    isNumber(message.ingressPort) &&
    isString(message.protocol) &&
    isRecord(message.appData) &&
    isString(message.egressServer),
  connectNetworkRelay: (message) =>
    isString(message.originId) &&
    isString(message.producerId) &&
    isString(message.routerNetwork) &&
    isRecord(message.consumerOptions) &&
    isBoolean(message.createNetworkPipeTransport) &&
    isString(message.ingressIp) &&
    isNumber(message.ingressPort) &&
    isString(message.protocol) &&
    isRecord(message.appData) &&
    isString(message.ingressServer),
  connectedNetworkRelay: (message) =>
    isString(message.originId) &&
    isString(message.routerNetwork) &&
    isString(message.producerId) &&
    isBoolean(message.connectedTransport) &&
    isString(message.egressIp) &&
    isNumber(message.egressPort) &&
    isString(message.protocol) &&
    isRecord(message.appData) &&
    isString(message.ingressServer),
  finalizeNetworkRelay: (message) =>
    isString(message.originId) &&
    isString(message.routerNetwork) &&
    isString(message.producerId) &&
    isBoolean(message.connectedTransport) &&
    isString(message.egressIp) &&
    isNumber(message.egressPort) &&
    isString(message.protocol) &&
    isString(message.egressServer),
  finalizedNetworkRelay: (message) =>
    isString(message.originId) &&
    isString(message.producerId) &&
    isString(message.routerNetwork) &&
    isMediaKind(message.kind) &&
    isString(message.ingressIp) &&
    isNumber(message.ingressPort) &&
    isString(message.egressIp) &&
    isNumber(message.egressPort) &&
    isString(message.egressServer),
} satisfies Partial<
  Record<MediaInboundPayload["type"], MediaInboundPayloadValidator>
>;

/** Validators for media-server lifecycle/service payloads. */
const MEDIA_SERVICE_VALIDATORS = {
  registerMediaServer: (message) =>
    isString(message.registrationId) &&
    isDirection(message.mode) &&
    isString(message.region),
  unregisterMediaServer: (message) =>
    isDirection(message.mode) &&
    isString(message.region) &&
    (message.reason === undefined || isString(message.reason)) &&
    (message.detail === undefined || isString(message.detail)),
  serverLoad: (message) =>
    isDirection(message.mode) &&
    isString(message.region) &&
    isNumber(message.load) &&
    (message.loadPerCpu === undefined || isNumberArray(message.loadPerCpu)),
  mediaDiagnostic: (message) =>
    isDirection(message.mode) &&
    isString(message.region) &&
    (message.severity === "warn" || message.severity === "error") &&
    isDiagnosticCategory(message.category) &&
    isString(message.message) &&
    (message.details === undefined || isString(message.details)) &&
    (message.context === undefined || isStringRecord(message.context)),
} satisfies Partial<
  Record<MediaInboundPayload["type"], MediaInboundPayloadValidator>
>;

/** Complete inbound netsocket validator lookup by payload `type`. */
const MEDIA_INBOUND_VALIDATORS = {
  ...MEDIA_REQUEST_VALIDATORS,
  ...MEDIA_RESPONSE_VALIDATORS,
  ...MEDIA_RELAY_VALIDATORS,
  ...MEDIA_SERVICE_VALIDATORS,
} satisfies Record<MediaInboundPayload["type"], MediaInboundPayloadValidator>;

/** Checks if provided discriminator is a known websocket request type. */
const hasUserRequestType = (type: string): type is UserRequestMessage["type"] =>
  Object.prototype.hasOwnProperty.call(USER_REQUEST_VALIDATORS, type);

/** Checks if provided discriminator is a known inbound netsocket payload type. */
const hasMediaInboundType = (
  type: string,
): type is MediaInboundPayload["type"] =>
  Object.prototype.hasOwnProperty.call(MEDIA_INBOUND_VALIDATORS, type);

/** Runs websocket request payload validator for known request type. */
const isUserRequestPayload = (
  type: UserRequestMessage["type"],
  message: unknown,
): boolean => {
  if (!isRecord(message)) {
    return false;
  }
  return USER_REQUEST_VALIDATORS[type](message);
};

/** Runs inbound netsocket payload validator for known payload type. */
const isMediaInboundMessage = (
  type: MediaInboundPayload["type"],
  message: unknown,
): boolean => {
  if (!isRecord(message)) {
    return false;
  }
  return MEDIA_INBOUND_VALIDATORS[type](message);
};

/**
 * Runtime guard for websocket user request payloads.
 *
 * @param value Unknown inbound websocket payload.
 * @returns `true` when payload matches `UserRequestMessage` contract.
 */
export const isUserRequestMessage = (
  value: unknown,
): value is UserRequestMessage => {
  if (!hasTypeAndMessage(value) || !hasUserRequestType(value.type)) {
    return false;
  }
  return isUserRequestPayload(value.type, value.message);
};

const isMediaInboundPayload = (
  value: unknown,
): value is MediaInboundPayload => {
  if (!hasTypeAndMessage(value) || !hasMediaInboundType(value.type)) {
    return false;
  }
  return isMediaInboundMessage(value.type, value.message);
};

/**
 * Runtime guard for inbound media signal wrappers on netsocket transport.
 *
 * @param value Unknown inbound netsocket envelope.
 * @returns `true` when payload matches `BidirectionalMediaSignalWrapper`.
 */
export const isBidirectionalMediaSignalWrapper = (
  value: unknown,
): value is BidirectionalMediaSignalWrapper =>
  isRecord(value) &&
  typeof value.node === "string" &&
  isMediaInboundPayload(value.payload);
