/**
 * Room lifecycle state-machine utilities.
 *
 * This reducer models room routing/readiness transitions independently from the
 * room service class so transitions are deterministic and testable.
 */

/** Coarse lifecycle phase derived from routing + readiness flags. */
export type RoomPhase = "empty" | "routing" | "egressPending" | "ready";

/** Immutable snapshot describing one room lifecycle state. */
export type RoomLifecycleState = {
  hasIngressRoutes: boolean;
  hasEgressRoutes: boolean;
  egressReady: boolean;
  phase: RoomPhase;
  version: number;
  updatedAt: string;
};

/** Supported lifecycle events that mutate room state. */
export type RoomLifecycleEvent =
  | {
      type: "routingUpdated";
      hasIngressRoutes: boolean;
      hasEgressRoutes: boolean;
    }
  | {
      type: "egressReadinessEvaluated";
      ready: boolean;
    }
  | {
      type: "roomDeleted";
    };

/**
 * Derives room phase from routing/readiness flags.
 *
 * @param state Derived-state inputs.
 * @returns Derived room phase label.
 */
const deriveRoomPhase = (state: {
  hasIngressRoutes: boolean;
  hasEgressRoutes: boolean;
  egressReady: boolean;
}): RoomPhase => {
  if (!state.hasIngressRoutes && !state.hasEgressRoutes) {
    return "empty";
  }
  if (!state.hasEgressRoutes) {
    return "routing";
  }
  return state.egressReady ? "ready" : "egressPending";
};

/**
 * Compares two state snapshots by derived lifecycle fields only.
 *
 * @param left Current state.
 * @param right Candidate next state.
 * @returns `true` when derived state is identical.
 */
const hasSameDerivedState = (
  left: RoomLifecycleState,
  right: RoomLifecycleState,
) =>
  left.hasIngressRoutes === right.hasIngressRoutes &&
  left.hasEgressRoutes === right.hasEgressRoutes &&
  left.egressReady === right.egressReady &&
  left.phase === right.phase;

/**
 * Creates a new room lifecycle state in `empty` phase.
 *
 * @param nowIso Optional timestamp override for deterministic tests.
 * @returns Initial room lifecycle snapshot.
 */
export const createInitialRoomLifecycleState = (
  nowIso = new Date().toISOString(),
): RoomLifecycleState => ({
  hasIngressRoutes: false,
  hasEgressRoutes: false,
  egressReady: false,
  phase: "empty",
  version: 0,
  updatedAt: nowIso,
});

/**
 * Applies a room lifecycle event and returns the next state snapshot.
 *
 * Returns `undefined` for `roomDeleted`, otherwise returns either the unchanged
 * current reference (derived state equivalent) or a new incremented snapshot.
 *
 * @param current Current lifecycle snapshot.
 * @param event Event to apply.
 * @param nowIso Optional timestamp override for deterministic tests.
 * @returns Next lifecycle state, or `undefined` when room is deleted.
 */
export const applyRoomLifecycleEvent = (
  current: RoomLifecycleState,
  event: RoomLifecycleEvent,
  nowIso = new Date().toISOString(),
): RoomLifecycleState | undefined => {
  if (event.type === "roomDeleted") {
    return undefined;
  }

  const nextBase = {
    hasIngressRoutes: current.hasIngressRoutes,
    hasEgressRoutes: current.hasEgressRoutes,
    egressReady: current.egressReady,
  };

  if (event.type === "routingUpdated") {
    nextBase.hasIngressRoutes = event.hasIngressRoutes;
    nextBase.hasEgressRoutes = event.hasEgressRoutes;
    if (!event.hasEgressRoutes) {
      nextBase.egressReady = false;
    }
  } else if (event.type === "egressReadinessEvaluated") {
    if (nextBase.hasEgressRoutes) {
      nextBase.egressReady = event.ready;
    } else {
      nextBase.egressReady = false;
    }
  }

  const next: RoomLifecycleState = {
    ...nextBase,
    phase: deriveRoomPhase(nextBase),
    version: current.version + 1,
    updatedAt: nowIso,
  };

  if (hasSameDerivedState(current, next)) {
    return current;
  }

  return next;
};
