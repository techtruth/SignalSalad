import type { Guid } from "../../../../types/baseTypes.d.ts";
import type {
  MediaServerMode,
  MediaServerRegionIndex,
  MediaServerLoadIndex,
} from "./types.js";

/**
 * Regional and load indexes consumed by server-selection helpers.
 *
 * Selection utilities take this read-only snapshot instead of mutating registry
 * state directly.
 */
export type MediaServerSelectionIndexes = {
  ingressRegions: MediaServerRegionIndex;
  egressRegions: MediaServerRegionIndex;
  ingressLoad: MediaServerLoadIndex;
  egressLoad: MediaServerLoadIndex;
};

const getRegionsByMode = (
  mode: MediaServerMode,
  indexes: MediaServerSelectionIndexes,
) => {
  return mode === "ingress" ? indexes.ingressRegions : indexes.egressRegions;
};

const getLoadByMode = (
  mode: MediaServerMode,
  indexes: MediaServerSelectionIndexes,
) => {
  return mode === "ingress" ? indexes.ingressLoad : indexes.egressLoad;
};

/**
 * Normalizes a requested region against known ingress/egress region labels
 * using case-insensitive lookup.
 */
export const resolveMediaServerRegionLabel = (
  region: string,
  ingressRegions: MediaServerRegionIndex,
  egressRegions: MediaServerRegionIndex,
) => {
  const requested = region.trim();
  const knownRegions = new Map<string, string>();
  Object.keys(ingressRegions).forEach((key) => {
    knownRegions.set(key.toLowerCase(), key);
  });
  Object.keys(egressRegions).forEach((key) => {
    const normalized = key.toLowerCase();
    if (!knownRegions.has(normalized)) {
      knownRegions.set(normalized, key);
    }
  });
  if (!requested) {
    return requested;
  }
  const normalized = requested.toLowerCase();
  return knownRegions.get(normalized) ?? requested;
};

/**
 * Returns true when a region exists in either ingress or egress regional pools.
 */
export const hasKnownMediaServerRegion = (
  region: string,
  ingressRegions: MediaServerRegionIndex,
  egressRegions: MediaServerRegionIndex,
) => {
  const resolved = resolveMediaServerRegionLabel(
    region,
    ingressRegions,
    egressRegions,
  );
  if (!resolved) {
    return false;
  }
  const hasIngress = Object.prototype.hasOwnProperty.call(
    ingressRegions,
    resolved,
  );
  const hasEgress = Object.prototype.hasOwnProperty.call(
    egressRegions,
    resolved,
  );
  return hasIngress || hasEgress;
};

/**
 * Resolves the configured region label for a media server id.
 */
export const resolveMediaServerRegion = (
  serverId: Guid,
  ingressRegions: MediaServerRegionIndex,
  egressRegions: MediaServerRegionIndex,
): string | undefined => {
  for (const [region, servers] of Object.entries(ingressRegions)) {
    if (servers.includes(serverId)) {
      return region;
    }
  }
  for (const [region, servers] of Object.entries(egressRegions)) {
    if (servers.includes(serverId)) {
      return region;
    }
  }
  return undefined;
};

/**
 * Selects the least-loaded server for a mode/region pair.
 *
 * When multiple servers share the same minimum load, one candidate is chosen
 * randomly to avoid deterministic hot-spotting.
 */
export const pickLeastLoadedMediaServer = (
  mode: MediaServerMode,
  region: string,
  indexes: MediaServerSelectionIndexes,
) => {
  const serverRegion = resolveMediaServerRegionLabel(
    region,
    indexes.ingressRegions,
    indexes.egressRegions,
  );
  const loadByMode = getLoadByMode(mode, indexes);
  const regionsByMode = getRegionsByMode(mode, indexes);
  if (!(serverRegion in loadByMode) || !(serverRegion in regionsByMode)) {
    return undefined;
  }
  const regionServers = regionsByMode[serverRegion];
  const entries = regionServers
    .map((serverId) => [serverId, loadByMode[serverRegion][serverId]] as const)
    .filter(([, load]) => typeof load === "number");
  if (!entries.length) {
    return undefined;
  }
  const minLoad = Math.min(...entries.map(([, load]) => load));
  const candidates = entries
    .filter(([, load]) => load === minLoad)
    .map(([serverId]) => serverId);
  if (!candidates.length) {
    return undefined;
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
};
