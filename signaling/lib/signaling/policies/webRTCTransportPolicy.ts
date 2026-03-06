/**
 * Default WebRTC transport policy implementations.
 */
import type { WebRTCTransportPolicies } from "./types.js";

/**
 * Default WebRTC transport policy.
 *
 * Allows ingress/egress create/connect actions; override in deployments that
 * need stricter admission based on tenant, room, or peer constraints.
 */
export const defaultWebRTCTransportPolicy: WebRTCTransportPolicies = {
  allowIngressTransportAction: () => true,
  allowEgressTransportAction: () => true,
};
