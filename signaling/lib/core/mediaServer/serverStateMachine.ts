/**
 * Media-server lifecycle state-machine utilities.
 *
 * The reducer models registration/load/ejection transitions used by server
 * registry orchestration.
 */
import type { Guid } from "../../../../types/baseTypes.d.ts";
import type { MediaServerMode } from "./types.js";

/** Coarse lifecycle phase for a media server node. */
export type MediaServerPhase =
  | "disconnected"
  | "registered"
  | "active"
  | "ejected";

/** Immutable snapshot describing one media-server lifecycle state. */
export type MediaServerState = {
  serverId: Guid;
  mode: MediaServerMode;
  region: string;
  phase: MediaServerPhase;
  connected: boolean;
  loadAvg: number | null;
  loadPerCpu: number[];
  registeredAt: string | null;
  updatedAt: string;
  lastEvent: "initialized" | "registered" | "loadReported" | "ejected";
};

/** Supported lifecycle events that mutate media-server state. */
export type MediaServerEvent =
  | {
      type: "registered";
      mode: MediaServerMode;
      region: string;
    }
  | {
      type: "loadReported";
      mode: MediaServerMode;
      region: string;
      load: number;
      loadPerCpu?: number[];
    }
  | {
      type: "ejected";
      mode: MediaServerMode;
      region: string;
    };

/**
 * Creates a disconnected server state snapshot before registration.
 *
 * @param serverId Target media-server id.
 * @param nowIso Optional timestamp override for deterministic tests.
 * @returns Initial disconnected server state snapshot.
 */
export const createInitialMediaServerState = (
  serverId: Guid,
  nowIso = new Date().toISOString(),
): MediaServerState => ({
  serverId,
  mode: "ingress",
  region: "",
  phase: "disconnected",
  connected: false,
  loadAvg: null,
  loadPerCpu: [],
  registeredAt: null,
  updatedAt: nowIso,
  lastEvent: "initialized",
});

/**
 * Applies a server lifecycle event and returns the next immutable state snapshot.
 *
 * @param current Current server lifecycle snapshot.
 * @param event Event to apply.
 * @param nowIso Optional timestamp override for deterministic tests.
 * @returns Next server lifecycle snapshot.
 */
export const applyMediaServerEvent = (
  current: MediaServerState,
  event: MediaServerEvent,
  nowIso = new Date().toISOString(),
): MediaServerState => {
  if (event.type === "registered") {
    return {
      ...current,
      mode: event.mode,
      region: event.region,
      phase: "registered",
      connected: true,
      registeredAt: current.registeredAt ?? nowIso,
      updatedAt: nowIso,
      lastEvent: "registered",
    };
  }

  if (event.type === "loadReported") {
    return {
      ...current,
      mode: event.mode,
      region: event.region,
      phase: "active",
      connected: true,
      loadAvg: event.load,
      loadPerCpu: event.loadPerCpu ?? [],
      registeredAt: current.registeredAt ?? nowIso,
      updatedAt: nowIso,
      lastEvent: "loadReported",
    };
  }

  return {
    ...current,
    mode: event.mode,
    region: event.region,
    phase: "ejected",
    connected: false,
    updatedAt: nowIso,
    lastEvent: "ejected",
  };
};
