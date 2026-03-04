/**
 * Signaling policy contract definitions.
 *
 * Policy interfaces are intentionally narrow so deployments can inject
 * environment-specific admission/rate-limit/media rules without coupling to
 * signaling internals.
 */
import type { Guid } from "../../../../types/baseTypes.d.ts";
import type { RequestMessage as UserRequestMessage } from "../../../../types/wsRelay.d.ts";

/** Decision result for identity/admission checks. */
export type AdmissionDecision =
  | { allowed: true }
  | { allowed: false; error: string; detail?: string };

/** Decision result for websocket rate-limit checks. */
export type WebSocketRateLimitDecision =
  | { allowed: true }
  | { allowed: false; detail: string };

/** Allowed transport operations exposed to transport policy hooks. */
export type WebRTCTransportActionType = "create" | "connect";

/** Admission policy hooks evaluated during websocket identity onboarding. */
export type AdmissionPolicies = {
  validateIdentityRegion: (params: {
    region: string;
    hasRegion: (region: string) => boolean;
  }) => AdmissionDecision;
};

/** Policy hooks controlling room media fanout/upload behaviors. */
export type RoomMediaPolicies = {
  allowRoomAudioRequest: (params: { actorPeerId: Guid }) => boolean;
  allowRoomVideoRequest: (params: { actorPeerId: Guid }) => boolean;
  allowRoomAudioUpload: (params: { actorPeerId: Guid }) => boolean;
  allowRoomVideoUpload: (params: { actorPeerId: Guid }) => boolean;
};

/** Policy hooks controlling WebRTC transport lifecycle actions. */
export type WebRTCTransportPolicies = {
  allowIngressTransportAction: (params: {
    actorPeerId: Guid;
    action: WebRTCTransportActionType;
  }) => boolean;
  allowEgressTransportAction: (params: {
    actorPeerId: Guid;
    action: WebRTCTransportActionType;
  }) => boolean;
};

/** Policy hooks for websocket request rate limiting and cleanup. */
export type RateLimitPolicies = {
  allowWebSocketRequest: (params: {
    wsid: Guid;
    messageType: UserRequestMessage["type"];
    nowMs: number;
  }) => WebSocketRateLimitDecision;
  onWebSocketDisconnected: (wsid: Guid) => void;
};

/** Complete policy bundle consumed by signaling request dispatch. */
export type SignalingPolicies = {
  admission: AdmissionPolicies;
  roomMedia: RoomMediaPolicies;
  webRTCTransport: WebRTCTransportPolicies;
  rateLimit: RateLimitPolicies;
};

/** Optional policy override shape used when composing `Signaling` runtime. */
export type PartialSignalingPolicies = Partial<{
  [K in keyof SignalingPolicies]: Partial<SignalingPolicies[K]>;
}>;
