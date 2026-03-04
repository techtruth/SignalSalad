/**
 * Shared media-server indexing and selection contracts.
 */
import type { Guid } from "../../../../types/baseTypes.d.ts";

/** Media-server role/channel in signaling topology. */
export type MediaServerMode = "ingress" | "egress";

/** Region -> media-server-id[] index. */
export type MediaServerRegionIndex = Record<string, string[]>;
/** Region -> (media-server-id -> load avg) index. */
export type MediaServerLoadIndex = Record<string, Record<string, number>>;
/** Region -> (media-server-id -> detailed load tuple) index. */
export type MediaServerLoadDetailIndex = Record<
  string,
  Record<string, { avg: number; perCpu: number[] }>
>;

/** Selected ingress/egress pair for one regional routing decision. */
export type MediaServerRegionalSelection = {
  selectedIngress: Guid | undefined;
  selectedEgress: Guid | undefined;
};
