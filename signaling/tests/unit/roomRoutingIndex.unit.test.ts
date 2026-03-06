/**
 * Why this file exists:
 * - Room routing accumulation/readiness state is the backbone for fanout planning.
 * - We need pure tests that assert room route/lifecycle behavior without
 *   websocket/netsocket fixtures.
 *
 * What this suite protects:
 * - unique ingress/egress route accumulation.
 * - lifecycle phase transitions from routing -> egressPending -> ready.
 * - readiness broadcast signature reset behavior.
 * - room deletion cleanup semantics.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Guid } from "../../../types/baseTypes.d.ts";
import { RoomRoutingIndex } from "../../lib/core/room/roomRoutingIndex.js";

test("room routing index: accumulates unique ingress and egress routes", () => {
  const roomRouting = new RoomRoutingIndex();
  const room = "demo-room";

  assert.equal(roomRouting.ensureRoomIngressRoute(room, "ingress-1"), true);
  assert.equal(roomRouting.ensureRoomIngressRoute(room, "ingress-1"), false);
  assert.equal(roomRouting.ensureRoomIngressRoute(room, "ingress-2"), true);
  assert.equal(roomRouting.ensureRoomEgressRoute(room, "egress-1"), true);
  assert.equal(roomRouting.ensureRoomEgressRoute(room, "egress-1"), false);

  assert.deepEqual(roomRouting.getRoutingTable().get(room), {
    ingress: ["ingress-1", "ingress-2"],
    egress: ["egress-1"],
  });
});

test("room routing index: lifecycle transitions with routing and readiness updates", () => {
  const roomRouting = new RoomRoutingIndex();
  const room = "demo-room";

  roomRouting.ensureRoomIngressRoute(room, "ingress-1");
  roomRouting.onRoomUpdated(room);
  const routingState = roomRouting.getRoomLifecycleState(room);
  assert.ok(routingState);
  assert.equal(routingState.phase, "routing");
  assert.equal(routingState.hasIngressRoutes, true);
  assert.equal(routingState.hasEgressRoutes, false);
  assert.equal(routingState.egressReady, false);

  roomRouting.ensureRoomEgressRoute(room, "egress-1");
  roomRouting.onRoomUpdated(room);
  const pendingState = roomRouting.getRoomLifecycleState(room);
  assert.ok(pendingState);
  assert.equal(pendingState.phase, "egressPending");
  assert.equal(pendingState.hasIngressRoutes, true);
  assert.equal(pendingState.hasEgressRoutes, true);
  assert.equal(pendingState.egressReady, false);

  roomRouting.recordRoomEgressReadiness(room, true);
  const readyState = roomRouting.getRoomLifecycleState(room);
  assert.ok(readyState);
  assert.equal(readyState.phase, "ready");
  assert.equal(readyState.egressReady, true);
});

test("room routing index: identical updates keep lifecycle snapshot stable", () => {
  const roomRouting = new RoomRoutingIndex();
  const room = "demo-room";

  roomRouting.ensureRoomIngressRoute(room, "ingress-1");
  roomRouting.onRoomUpdated(room);
  const stateAfterFirstUpdate = roomRouting.getRoomLifecycleState(room);
  assert.ok(stateAfterFirstUpdate);

  roomRouting.onRoomUpdated(room);
  const stateAfterSecondUpdate = roomRouting.getRoomLifecycleState(room);
  assert.equal(stateAfterSecondUpdate, stateAfterFirstUpdate);
});

test("room routing index: egress-ready broadcast resets on signature changes", () => {
  const roomRouting = new RoomRoutingIndex();
  const room = "demo-room";

  const initial = roomRouting.beginRoomEgressReadyBroadcast(room, [
    "egress-a" as Guid,
    "egress-b" as Guid,
  ]);
  initial.add("peer-1" as Guid);
  roomRouting.setRoomEgressReadyNotifiedPeers(room, initial);

  const sameSignature = roomRouting.beginRoomEgressReadyBroadcast(room, [
    "egress-b" as Guid,
    "egress-a" as Guid,
  ]);
  assert.equal(sameSignature.has("peer-1"), true);

  const changedSignature = roomRouting.beginRoomEgressReadyBroadcast(room, [
    "egress-a" as Guid,
    "egress-c" as Guid,
  ]);
  assert.equal(changedSignature.size, 0);
});

test("room routing index: deleteRoom removes routing and lifecycle snapshots", () => {
  const roomRouting = new RoomRoutingIndex();
  const room = "demo-room";

  roomRouting.ensureRoomIngressRoute(room, "ingress-1");
  roomRouting.ensureRoomEgressRoute(room, "egress-1");
  roomRouting.onRoomUpdated(room);
  assert.ok(roomRouting.getRoomLifecycleState(room));

  roomRouting.deleteRoom(room);

  assert.equal(roomRouting.getRoutingTable().has(room), false);
  assert.equal(roomRouting.getRoomLifecycleState(room), undefined);
});
