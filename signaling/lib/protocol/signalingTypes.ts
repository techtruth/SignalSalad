import type { Guid } from "../../../types/baseTypes.d.ts";

/**
 * Shared signaling routing/pipe type contracts used across signaling modules.
 *
 * These types are protocol-adjacent shared models consumed by room/media
 * orchestration and status reporting.
 */

/**
 * Room-level media server assignment entry (`room -> ingress[]/egress[]`).
 *
 * The routing table maps one room to the current set of ingress/egress servers
 * involved in relay setup for that room.
 */
export type RoutingTableItems = {
  ingress: Guid[];
  egress: Guid[];
};

/**
 * Persisted ingress<->egress network pipe mapping for room fanout.
 *
 * Each entry represents one known pipe transport pair and the producer ids
 * currently associated with that relay path.
 */
export type MediaServerPipe = {
  ingress: Guid;
  egress: Guid;
  ingressPort: number;
  egressPort: number;
  room: string;
  producerIds: Guid[];
};
