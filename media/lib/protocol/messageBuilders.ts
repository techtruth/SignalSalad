import type {
  NsRelayMessageMap,
  NsResponseMessageMap,
  NsServiceMessageMap,
  NetworkRelayPayload,
  ResponsePayload,
  ServiceMessage,
} from "../../../types/nsRelay.d.ts";

/**
 * Media-side payload and message builders used by `mediaSignaling`.
 *
 * These helpers keep control-plane payload shaping in one module so
 * `MediaSignaling` can stay focused on transport and orchestration.
 */

export const buildServicePayload = <T extends keyof NsServiceMessageMap>(
  type: T,
  message: NsServiceMessageMap[T],
): ServiceMessage => ({ type, message } as ServiceMessage);

/** Builds typed service-response envelope payload for signaling replies. */
export const buildResponsePayload = <T extends keyof NsResponseMessageMap>(
  type: T,
  message: NsResponseMessageMap[T],
): ResponsePayload => ({ type, message } as ResponsePayload);

/** Builds typed relay envelope payload for cross-node network relay messages. */
export const buildRelayPayload = <T extends keyof NsRelayMessageMap>(
  type: T,
  message: NsRelayMessageMap[T],
): NetworkRelayPayload => ({ type, message } as NetworkRelayPayload);

/** Builds `registerMediaServer` service message payload. */
export const buildRegisterMediaServerMessage = (
  registrationId: string,
  mode: "ingress" | "egress",
  region: string,
): NsServiceMessageMap["registerMediaServer"] => ({
  registrationId,
  mode,
  region,
});

/** Builds `unregisterMediaServer` service message payload. */
export const buildUnregisterMediaServerMessage = (params: {
  mode: "ingress" | "egress";
  region: string;
  reason?: string;
  detail?: string;
}): NsServiceMessageMap["unregisterMediaServer"] => ({
  mode: params.mode,
  region: params.region,
  reason: params.reason,
  detail: params.detail,
});

/** Builds periodic `serverLoad` heartbeat payload. */
export const buildServerLoadMessage = (params: {
  mode: "ingress" | "egress";
  region: string;
  load: number;
  loadPerCpu: number[];
}): NsServiceMessageMap["serverLoad"] => ({
  mode: params.mode,
  region: params.region,
  load: params.load,
  loadPerCpu: params.loadPerCpu,
});

/** Builds `mediaDiagnostic` service payload emitted by media runtime. */
export const buildMediaDiagnosticMessage = (params: {
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
}): NsServiceMessageMap["mediaDiagnostic"] => ({
  mode: params.mode,
  region: params.region,
  severity: params.severity,
  category: params.category,
  message: params.message,
  details: params.details,
  context: params.context,
});

/** Passthrough builder for `createdRouterGroup` response payload. */
export const buildCreatedRouterGroupMessage = (
  message: NsResponseMessageMap["createdRouterGroup"],
): NsResponseMessageMap["createdRouterGroup"] => message;

/** Passthrough builder for `createdWebRTCIngressTransport` response payload. */
export const buildCreatedWebRTCTransportMessage = (
  message: NsResponseMessageMap["createdWebRTCIngressTransport"],
): NsResponseMessageMap["createdWebRTCIngressTransport"] => message;

/** Builds `connectedWebRTCIngressTransport` response payload. */
export const buildConnectedWebRTCTransportMessage = (
  originId: string,
): NsResponseMessageMap["connectedWebRTCIngressTransport"] => ({
  originId,
});

/** Passthrough builder for `createdMediaProducer` response payload. */
export const buildCreatedMediaProducerMessage = (
  message: NsResponseMessageMap["createdMediaProducer"],
): NsResponseMessageMap["createdMediaProducer"] => message;

/** Builds `producerClosed` response payload from producer lifecycle callback. */
export const buildProducerClosedMessage = (params: {
  originId: string;
  producerId: string;
  mediaType: string;
}): NsResponseMessageMap["producerClosed"] => ({
  originId: params.originId,
  producerId: params.producerId,
  mediaType: params.mediaType,
});

/** Builds `disconnectedWebRTCTransport` response payload. */
export const buildDisconnectedWebRTCTransportMessage = (params: {
  transportId: string;
  originId?: string;
  direction: "ingress" | "egress";
}): NsResponseMessageMap["disconnectedWebRTCTransport"] => ({
  transportId: params.transportId,
  originId: params.originId,
  direction: params.direction,
});

/** Passthrough builder for `createdConsumer` response payload. */
export const buildCreatedConsumerMessage = (
  message: NsResponseMessageMap["createdConsumer"],
): NsResponseMessageMap["createdConsumer"] => message;

/** Passthrough builder for `routerDump` response payload. */
export const buildRouterDumpMessage = (
  message: NsResponseMessageMap["routerDump"],
): NsResponseMessageMap["routerDump"] => message;

/** Passthrough builder for `initializedNetworkRelay` relay payload. */
export const buildInitializedNetworkRelayMessage = (
  message: NsRelayMessageMap["initializedNetworkRelay"],
): NsRelayMessageMap["initializedNetworkRelay"] => message;

/** Passthrough builder for `connectedNetworkRelay` relay payload. */
export const buildConnectedNetworkRelayMessage = (
  message: NsRelayMessageMap["connectedNetworkRelay"],
): NsRelayMessageMap["connectedNetworkRelay"] => message;

/** Passthrough builder for `finalizedNetworkRelay` relay payload. */
export const buildFinalizedNetworkRelayMessage = (
  message: NsRelayMessageMap["finalizedNetworkRelay"],
): NsRelayMessageMap["finalizedNetworkRelay"] => message;
