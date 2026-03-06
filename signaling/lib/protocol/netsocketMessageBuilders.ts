import type {
  DtlsParameters,
  NumSctpStreams,
  RtpCapabilities,
} from "mediasoup/types";

import type { Guid } from "../../../types/baseTypes.d.ts";
import type { NsMessageMap } from "./signalingIoValidation.js";

/**
 * Netsocket-focused message constructors.
 *
 * These builders shape payloads sent to media nodes from signaling.
 */

/**
 * Creates `createRouterGroup` netsocket payload for room route allocation.
 *
 * @param origin Origin websocket id.
 * @param room Target room id.
 * @returns Typed `createRouterGroup` payload.
 */
export const buildCreateRouterGroupMessage = (
  origin: Guid,
  room: string,
): NsMessageMap["createRouterGroup"] => ({
  origin,
  room,
});

/**
 * Creates `dumpRouterGroup` netsocket payload for status/diagnostic snapshots.
 *
 * @param origin Origin request id for correlating dump callbacks.
 * @param room Target room id to dump.
 * @returns Typed `dumpRouterGroup` payload.
 */
export const buildDumpRouterGroupMessage = (
  origin: Guid,
  room: string,
): NsMessageMap["dumpRouterGroup"] => ({
  origin,
  room,
});

/**
 * Creates `destroyRouterGroup` netsocket payload for room teardown.
 *
 * @param room Room id to destroy.
 * @returns Typed `destroyRouterGroup` payload.
 */
export const buildDestroyRouterGroupMessage = (
  room: string,
): NsMessageMap["destroyRouterGroup"] => ({
  routerNetwork: room,
});

/**
 * Creates `createWebRTCIngressTransport` netsocket payload.
 *
 * @param params Transport creation inputs.
 * @returns Typed `createWebRTCIngressTransport` payload.
 */
export const buildCreateWebRTCIngressTransportMessage = (params: {
  originId: Guid;
  sctpOptions: NumSctpStreams;
  room: string;
}): NsMessageMap["createWebRTCIngressTransport"] => ({
  originId: params.originId,
  sctpOptions: params.sctpOptions,
  routerNetwork: params.room,
});

/**
 * Creates `createWebRTCEgressTransport` netsocket payload.
 *
 * @param params Transport creation inputs.
 * @returns Typed `createWebRTCEgressTransport` payload.
 */
export const buildCreateWebRTCEgressTransportMessage = (params: {
  originId: Guid;
  sctpOptions: NumSctpStreams;
  room: string;
}): NsMessageMap["createWebRTCEgressTransport"] => ({
  originId: params.originId,
  sctpOptions: params.sctpOptions,
  routerNetwork: params.room,
});

/**
 * Creates connect payload for ingress or egress WebRTC transport.
 *
 * @param params Transport id and DTLS parameters.
 * @returns Typed connect transport payload.
 */
export const buildConnectWebRTCTransportMessage = (params: {
  originId: Guid;
  transportId: Guid;
  dtlsParameters: DtlsParameters;
}): NsMessageMap["connectWebRTCIngressTransport"] => ({
  originId: params.originId,
  transportId: params.transportId,
  dtlsParameters: params.dtlsParameters,
});

/**
 * Creates `createMediaProducer` netsocket payload from peer/session metadata.
 *
 * @param params Producer creation inputs.
 * @returns Typed `createMediaProducer` payload.
 */
export const buildCreateMediaProducerMessage = (params: {
  originId: Guid;
  transportId: Guid;
  producerOptions: NsMessageMap["createMediaProducer"]["producerOptions"];
  room: string;
  rtpCapabilities: RtpCapabilities;
  egress: Guid;
  requestId: string;
}): NsMessageMap["createMediaProducer"] => ({
  originId: params.originId,
  transportId: params.transportId,
  producerOptions: params.producerOptions,
  routerNetwork: params.room,
  rtpCapabilities: params.rtpCapabilities,
  egress: params.egress,
  requestId: params.requestId,
});

/**
 * Creates `createConsumer` netsocket payload for room fanout requests.
 *
 * @param params Consumer planning inputs.
 * @returns Typed `createConsumer` payload.
 */
export const buildCreateConsumerMessage = (params: {
  kind: "audio" | "video";
  consumerTransportId: Guid;
  producerIds: { [producerPeerId: string]: Guid[] }[];
  room: string;
  rtpCaps: RtpCapabilities;
}): NsMessageMap["createConsumer"] => ({
  kind: params.kind,
  consumerTransports: [params.consumerTransportId],
  producerIds: params.producerIds,
  room: params.room,
  rtpCaps: params.rtpCaps,
});

/**
 * Creates `producerClose` payload for ingress/egress producer teardown fanout.
 *
 * @param peerId Owning peer id.
 * @param producerId Producer id being closed.
 * @param mediaType Media type label.
 * @returns Typed `producerClose` payload.
 */
export const buildProducerCloseMessage = (
  peerId: Guid,
  producerId: Guid,
  mediaType: string,
): NsMessageMap["producerClose"] => ({
  peerId,
  producerId,
  mediaType,
});

/**
 * Creates `setProducerPaused` payload for producer mute/unmute control.
 *
 * @param params Pause toggle inputs.
 * @returns Typed `setProducerPaused` payload.
 */
export const buildSetProducerPausedMessage = (params: {
  producerId: Guid;
  paused: boolean;
}): NsMessageMap["setProducerPaused"] => ({
  producerId: params.producerId,
  paused: params.paused,
});

/**
 * Creates `connectNetworkRelay` payload for ingress->egress relay handshake.
 *
 * @param params Relay connect handshake inputs.
 * @returns Typed `connectNetworkRelay` payload.
 */
export const buildConnectNetworkRelayMessage = (params: {
  originId: Guid;
  producerId: Guid;
  routerNetwork: string;
  consumerOptions: NsMessageMap["connectNetworkRelay"]["consumerOptions"];
  createNetworkPipeTransport: boolean;
  ingressIp: string;
  ingressPort: number;
  protocol: NsMessageMap["connectNetworkRelay"]["protocol"];
  appData: NsMessageMap["connectNetworkRelay"]["appData"];
  ingressServer: Guid;
}): NsMessageMap["connectNetworkRelay"] => ({
  originId: params.originId,
  producerId: params.producerId,
  routerNetwork: params.routerNetwork,
  consumerOptions: params.consumerOptions,
  createNetworkPipeTransport: params.createNetworkPipeTransport,
  ingressIp: params.ingressIp,
  ingressPort: params.ingressPort,
  protocol: params.protocol,
  appData: params.appData,
  ingressServer: params.ingressServer,
});

/**
 * Creates `finalizeNetworkRelay` payload for egress->ingress handshake completion.
 *
 * @param params Relay finalize handshake inputs.
 * @returns Typed `finalizeNetworkRelay` payload.
 */
export const buildFinalizeNetworkRelayMessage = (params: {
  originId: Guid;
  routerNetwork: string;
  producerId: Guid;
  connectedTransport: boolean;
  egressIp: string;
  egressPort: number;
  protocol: NsMessageMap["finalizeNetworkRelay"]["protocol"];
  egressServer: Guid;
}): NsMessageMap["finalizeNetworkRelay"] => ({
  originId: params.originId,
  routerNetwork: params.routerNetwork,
  producerId: params.producerId,
  connectedTransport: params.connectedTransport,
  egressIp: params.egressIp,
  egressPort: params.egressPort,
  protocol: params.protocol,
  egressServer: params.egressServer,
});

/**
 * Creates `teardownPeerSession` payload for peer lifecycle cleanup fanout.
 *
 * @param params Peer-session teardown inputs.
 * @returns Typed `teardownPeerSession` payload.
 */
export const buildTeardownPeerSessionMessage = (params: {
  originId: Guid;
  peerId: Guid;
  operationId: Guid;
  mode: "leaving" | "closing";
  transportIds: Guid[];
  producerIds: Guid[];
}): NsMessageMap["teardownPeerSession"] => ({
  originId: params.originId,
  peerId: params.peerId,
  operationId: params.operationId,
  mode: params.mode,
  transportIds: params.transportIds,
  producerIds: params.producerIds,
});
