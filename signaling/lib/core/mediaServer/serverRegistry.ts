import type { Guid } from "../../../../types/baseTypes.d.ts";
import {
  hasKnownMediaServerRegion,
  pickLeastLoadedMediaServer,
  resolveMediaServerRegionLabel,
  resolveMediaServerRegion,
} from "./serverLoadSelection.js";
import {
  applyMediaServerEvent,
  createInitialMediaServerState,
  type MediaServerState,
} from "./serverStateMachine.js";
import type {
  MediaServerMode,
  MediaServerRegionIndex,
  MediaServerLoadDetailIndex,
  MediaServerLoadIndex,
  MediaServerRegionalSelection,
} from "./types.js";

/** Lifecycle snapshot stored per media server in `MediaServerRegistry`. */
export type MediaServerLifecycleRecord = MediaServerState;

/**
 * Maintains region + load indexes used by signaling server selection logic.
 *
 * This wrapper keeps normalization, least-loaded selection, and pruning behavior
 * in one place while preserving reference semantics for the underlying maps.
 */
export class MediaServerRegistry {
  private readonly ingressRegions: MediaServerRegionIndex;
  private readonly egressRegions: MediaServerRegionIndex;
  private readonly ingressLoad: MediaServerLoadIndex;
  private readonly egressLoad: MediaServerLoadIndex;
  private readonly ingressLoadDetail: MediaServerLoadDetailIndex;
  private readonly egressLoadDetail: MediaServerLoadDetailIndex;
  private readonly serverLifecycles: Map<Guid, MediaServerLifecycleRecord>;
  private readonly maxDisconnectedServers: number;

  /**
   * Creates a registry backed by caller-provided region/load indexes.
   *
   * @param params - Shared region/load map references and retention limits.
   * @throws {Error} When `maxDisconnectedServers` is negative or not an integer.
   */
  constructor(params: {
    ingressRegions: MediaServerRegionIndex;
    egressRegions: MediaServerRegionIndex;
    ingressLoad: MediaServerLoadIndex;
    egressLoad: MediaServerLoadIndex;
    ingressLoadDetail: MediaServerLoadDetailIndex;
    egressLoadDetail: MediaServerLoadDetailIndex;
    maxDisconnectedServers: number;
  }) {
    this.ingressRegions = params.ingressRegions;
    this.egressRegions = params.egressRegions;
    this.ingressLoad = params.ingressLoad;
    this.egressLoad = params.egressLoad;
    this.ingressLoadDetail = params.ingressLoadDetail;
    this.egressLoadDetail = params.egressLoadDetail;
    this.serverLifecycles = new Map<Guid, MediaServerLifecycleRecord>();
    this.maxDisconnectedServers = params.maxDisconnectedServers;
    if (
      !Number.isInteger(this.maxDisconnectedServers) ||
      this.maxDisconnectedServers < 0
    ) {
      throw new Error(
        `Invalid maxDisconnectedServers value '${String(
          params.maxDisconnectedServers,
        )}'. Expected a non-negative integer.`,
      );
    }
  }

  private pruneDisconnectedLifecycles() {
    const disconnected = new Array<{ serverId: Guid; updatedAtMs: number }>();
    for (const [serverId, lifecycle] of this.serverLifecycles.entries()) {
      if (lifecycle.connected) {
        continue;
      }
      const parsedUpdatedAt = Date.parse(lifecycle.updatedAt);
      disconnected.push({
        serverId,
        updatedAtMs: Number.isFinite(parsedUpdatedAt)
          ? parsedUpdatedAt
          : Number.MIN_SAFE_INTEGER,
      });
    }
    if (disconnected.length <= this.maxDisconnectedServers) {
      return;
    }
    disconnected.sort((a, b) => b.updatedAtMs - a.updatedAtMs);
    const keptServerIds = new Set<Guid>(
      disconnected
        .slice(0, this.maxDisconnectedServers)
        .map((entry) => entry.serverId),
    );
    for (const { serverId } of disconnected) {
      if (!keptServerIds.has(serverId)) {
        this.serverLifecycles.delete(serverId);
      }
    }
  }

  private normalizeRegion(region: string) {
    return resolveMediaServerRegionLabel(
      region,
      this.ingressRegions,
      this.egressRegions,
    );
  }

  private removeServerFromRegionIndex(mode: MediaServerMode, serverId: Guid) {
    this.pruneServerFromRegionListIndex(this.getRegionsByMode(mode), serverId);
  }

  private ensureServerInRegion(
    mode: MediaServerMode,
    region: string,
    serverId: Guid,
  ) {
    const regionIndex = this.getRegionsByMode(mode);
    if (!regionIndex[region]) {
      regionIndex[region] = [];
    }
    if (!regionIndex[region].includes(serverId)) {
      regionIndex[region].push(serverId);
    }
  }

  private updateServerLifecycle(
    serverId: Guid,
    event: Parameters<typeof applyMediaServerEvent>[1],
  ) {
    const current =
      this.serverLifecycles.get(serverId) ??
      createInitialMediaServerState(serverId);
    const next = applyMediaServerEvent(current, event);
    this.serverLifecycles.set(serverId, next);
    this.pruneDisconnectedLifecycles();
    return next;
  }

  /**
   * Registers one media server in mode/region indexes.
   *
   * @param mode - Server role (`ingress` or `egress`).
   * @param region - Requested region label.
   * @param serverId - Server id.
   * @returns Normalized region label stored in indexes.
   */
  registerServer(mode: MediaServerMode, region: string, serverId: Guid) {
    const resolvedRegion = this.normalizeRegion(region);
    this.removeServerFromRegionIndex(mode, serverId);
    this.ensureServerInRegion(mode, resolvedRegion, serverId);
    const { loadIndex, loadDetailIndex } = this.ensureLoadIndexesForRegion(
      mode,
      resolvedRegion,
    );
    if (loadIndex[resolvedRegion][serverId] === undefined) {
      loadIndex[resolvedRegion][serverId] = 0;
    }
    if (!loadDetailIndex[resolvedRegion][serverId]) {
      loadDetailIndex[resolvedRegion][serverId] = {
        avg: 0,
        perCpu: [],
      };
    }
    this.updateServerLifecycle(serverId, {
      type: "registered",
      mode,
      region: resolvedRegion,
    });
    return resolvedRegion;
  }

  private getRegionsByMode(mode: MediaServerMode) {
    return mode === "ingress" ? this.ingressRegions : this.egressRegions;
  }

  private getLoadByMode(mode: MediaServerMode) {
    return mode === "ingress" ? this.ingressLoad : this.egressLoad;
  }

  private getLoadDetailByMode(mode: MediaServerMode) {
    return mode === "ingress" ? this.ingressLoadDetail : this.egressLoadDetail;
  }

  private ensureLoadIndexesForRegion(mode: MediaServerMode, region: string) {
    const loadIndex = this.getLoadByMode(mode);
    const loadDetailIndex = this.getLoadDetailByMode(mode);
    if (!loadIndex[region]) {
      loadIndex[region] = {};
    }
    if (!loadDetailIndex[region]) {
      loadDetailIndex[region] = {};
    }
    return { loadIndex, loadDetailIndex };
  }

  private pruneServerFromRegionListIndex(
    regionIndex: MediaServerRegionIndex,
    serverId: Guid,
  ) {
    for (const region of Object.keys(regionIndex)) {
      regionIndex[region] = regionIndex[region].filter((id) => id !== serverId);
      if (!regionIndex[region].length) {
        delete regionIndex[region];
      }
    }
  }

  private pruneServerFromRegionalServerMap<T>(
    regionalIndex: Record<string, Record<string, T>>,
    serverId: Guid,
  ) {
    for (const region of Object.keys(regionalIndex)) {
      delete regionalIndex[region][serverId];
      if (!Object.keys(regionalIndex[region]).length) {
        delete regionalIndex[region];
      }
    }
  }

  private resolveEjectedServerRegion(mode: MediaServerMode, serverId: Guid) {
    const lifecycleRegion = this.serverLifecycles.get(serverId)?.region;
    if (lifecycleRegion) {
      return lifecycleRegion;
    }

    const regionIndex = this.getRegionsByMode(mode);
    for (const region of Object.keys(regionIndex)) {
      if (regionIndex[region].includes(serverId)) {
        return region;
      }
    }

    const loadIndex = this.getLoadByMode(mode);
    for (const region of Object.keys(loadIndex)) {
      if (loadIndex[region][serverId] !== undefined) {
        return region;
      }
    }

    const loadDetailIndex = this.getLoadDetailByMode(mode);
    for (const region of Object.keys(loadDetailIndex)) {
      if (loadDetailIndex[region][serverId] !== undefined) {
        return region;
      }
    }

    throw new Error(
      `Cannot eject media server '${serverId}' for mode '${mode}': server region is unknown`,
    );
  }

  private resolveRegisteredServerRegionForLoad(
    mode: MediaServerMode,
    serverId: Guid,
  ) {
    const lifecycle = this.serverLifecycles.get(serverId);
    if (lifecycle?.connected && lifecycle.mode === mode) {
      return lifecycle.region;
    }

    const regionIndex = this.getRegionsByMode(mode);
    for (const region of Object.keys(regionIndex)) {
      if (regionIndex[region].includes(serverId)) {
        return region;
      }
    }

    throw new Error(
      `Cannot record server load for '${serverId}' in mode '${mode}': server is not registered`,
    );
  }

  /**
   * Records load snapshot for a registered media server.
   *
   * @param mode - Server role (`ingress` or `egress`).
   * @param region - Reported region label from media heartbeat.
   * @param serverId - Server id.
   * @param load - Aggregate load value.
   * @param loadPerCpu - Optional per-CPU load distribution.
   * @returns `void`.
   * @throws {Error} When server is not registered or reported region mismatches registered region.
   */
  setServerLoadSnapshot(
    mode: MediaServerMode,
    region: string,
    serverId: Guid,
    load: number,
    loadPerCpu: number[] | undefined,
  ) {
    const resolvedRegion = this.resolveRegisteredServerRegionForLoad(
      mode,
      serverId,
    );
    const reportedRegion = this.normalizeRegion(region);
    if (reportedRegion !== resolvedRegion) {
      throw new Error(
        `Cannot record server load for '${serverId}' in mode '${mode}': reported region '${reportedRegion}' does not match registered region '${resolvedRegion}'`,
      );
    }
    const { loadIndex, loadDetailIndex } = this.ensureLoadIndexesForRegion(
      mode,
      resolvedRegion,
    );
    loadIndex[resolvedRegion][serverId] = load;
    loadDetailIndex[resolvedRegion][serverId] = {
      avg: load,
      perCpu: loadPerCpu ?? [],
    };
    this.updateServerLifecycle(serverId, {
      type: "loadReported",
      mode,
      region: resolvedRegion,
      load,
      loadPerCpu,
    });
  }

  /**
   * Ejects one server from region/load indexes and records lifecycle transition.
   *
   * @param mode - Server role (`ingress` or `egress`).
   * @param serverId - Server id to prune.
   * @returns `void`.
   * @throws {Error} When server region cannot be resolved for ejection.
   */
  pruneServerRegionAndLoad(mode: MediaServerMode, serverId: Guid) {
    const ejectedRegion = this.resolveEjectedServerRegion(mode, serverId);

    const regionIndex = this.getRegionsByMode(mode);
    const loadIndex = this.getLoadByMode(mode);
    const loadDetailIndex = this.getLoadDetailByMode(mode);

    this.pruneServerFromRegionListIndex(regionIndex, serverId);
    this.pruneServerFromRegionalServerMap(loadIndex, serverId);
    this.pruneServerFromRegionalServerMap(loadDetailIndex, serverId);

    this.updateServerLifecycle(serverId, {
      type: "ejected",
      mode,
      region: ejectedRegion,
    });
  }

  /**
   * Picks least-loaded server for one role/region.
   *
   * @param mode - Server role (`ingress` or `egress`).
   * @param region - Desired region label.
   * @returns Selected server id, or `undefined` when no server is available.
   */
  getLeastLoadedServerByMode(mode: MediaServerMode, region: string) {
    return pickLeastLoadedMediaServer(mode, region, {
      ingressRegions: this.ingressRegions,
      egressRegions: this.egressRegions,
      ingressLoad: this.ingressLoad,
      egressLoad: this.egressLoad,
    });
  }

  /**
   * Selects ingress and egress candidates for one region.
   *
   * @param region - Desired region label.
   * @returns Selected ingress/egress ids.
   */
  selectRegionalServers(region: string): MediaServerRegionalSelection {
    return {
      selectedIngress: this.getLeastLoadedServerByMode("ingress", region),
      selectedEgress: this.getLeastLoadedServerByMode("egress", region),
    };
  }

  /**
   * Resolves known region label for a server.
   *
   * @param serverId - Server id.
   * @returns Region label when known, otherwise `undefined`.
   */
  resolveServerToRegion(serverId: Guid): string | undefined {
    const trackedRegion = this.serverLifecycles.get(serverId)?.region;
    if (trackedRegion) {
      return trackedRegion;
    }
    return resolveMediaServerRegion(
      serverId,
      this.ingressRegions,
      this.egressRegions,
    );
  }

  /**
   * Returns lifecycle snapshot for one server.
   *
   * @param serverId - Server id.
   * @returns Lifecycle record, or `undefined` if never tracked.
   */
  getServerLifecycle(serverId: Guid) {
    return this.serverLifecycles.get(serverId);
  }

  /**
   * Returns all tracked lifecycle snapshots.
   *
   * @returns Array of lifecycle records.
   */
  getServerLifecycles() {
    return [...this.serverLifecycles.values()];
  }

  /**
   * Reports whether server is currently connected in lifecycle state.
   *
   * @param serverId - Server id.
   * @returns `true` when connected, otherwise `false`.
   */
  isServerConnected(serverId: Guid) {
    return this.serverLifecycles.get(serverId)?.connected ?? false;
  }

  /**
   * Normalizes a region label against known region indexes.
   *
   * @param region - Requested region label.
   * @returns Normalized region label.
   */
  resolveRegion(region: string) {
    return resolveMediaServerRegionLabel(
      region,
      this.ingressRegions,
      this.egressRegions,
    );
  }

  /**
   * Checks whether a region label is known in either ingress or egress indexes.
   *
   * @param region - Region label to check.
   * @returns `true` when region is known.
   */
  hasRegion(region: string) {
    return hasKnownMediaServerRegion(
      region,
      this.ingressRegions,
      this.egressRegions,
    );
  }
}
