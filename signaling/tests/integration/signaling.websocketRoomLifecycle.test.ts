/**
 * Why this file exists:
 * - This is the minimal websocket room lifecycle contract without media complexity.
 * - It verifies identity + room state transitions are correct before transport/producer flows.
 * - It catches ownership/state mistakes at the first protocol layer.
 *
 * What this suite protects:
 * - requestIdentity -> joinRoom -> leaveRoom happy path.
 * - rejection when identity is missing.
 * - rejection on peer ownership mismatch.
 * - rejection on leaving a room that does not match current state.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  closeCodes: number[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

const createFakeWs = (): FakeWs => ({
  sent: [],
  closeCodes: [],
  send(payload: string) {
    this.sent.push(payload);
  },
  close(code: number) {
    this.closeCodes.push(code);
  },
});

const parseWsMessages = (socket: FakeWs) =>
  socket.sent.map((entry) => JSON.parse(entry) as { type: string; message: unknown });

const createHarness = () => {
  const wsid = "ws-test-1" as Guid;
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const room = "demo";
  const region = "local";

  const netsocketWrites: Array<{ node: string; payload: { type: string; message: unknown } }> = [];

  const fakeWs = createFakeWs();
  const wsClients = new Map<Guid, unknown>([
    [wsid, fakeWs as unknown],
  ]);

  const ingressSocket = { remoteAddress: "127.0.0.1" } as NetSocket;
  const egressSocket = { remoteAddress: "127.0.0.1" } as NetSocket;
  const ingress = new Map<Guid, NetSocket>([[ingressServerId, ingressSocket]]);
  const egress = new Map<Guid, NetSocket>([[egressServerId, egressSocket]]);
  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const encoder = {
    write(buffer: Buffer) {
      netsocketWrites.push(JSON.parse(buffer.toString()));
      return true;
    },
  } as unknown as Transform;
  nsEncoders.set(ingressSocket, encoder);
  nsEncoders.set(egressSocket, encoder);

  const servers = createTestServers({
    wsClients,
    ingress,
    egress,
    nsEncoders,
  });

  const manager = new Signaling({
    ...servers,
    ingressRegions: { [region]: [ingressServerId] },
    egressRegions: { [region]: [egressServerId] },
    ingressLoad: { [region]: { [ingressServerId]: 1 } },
    egressLoad: { [region]: { [egressServerId]: 1 } },
  });

  return {
    manager,
    wsid,
    room,
    region,
    fakeWs,
    netsocketWrites,
  };
};

test("websocket room lifecycle happy path: requestIdentity -> joinRoom -> leaveRoom", async () => {
  const harness = createHarness();

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "requestIdentity",
    message: { region: harness.region },
  });

  const identityEvent = parseWsMessages(harness.fakeWs).find(
    (event) => event.type === "identity",
  );
  assert.ok(identityEvent);
  const peerId = (identityEvent.message as { peerId: Guid }).peerId;

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "joinRoom",
    message: { peerId, room: harness.room },
  });

  assert.ok(
    parseWsMessages(harness.fakeWs).find((event) => event.type === "roomAttached"),
  );
  assert.equal(
    harness.netsocketWrites.filter(
      (entry) => entry.payload.type === "createRouterGroup",
    ).length,
    2,
  );

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "leaveRoom",
    message: { peerId, room: harness.room },
  });

  assert.ok(
    parseWsMessages(harness.fakeWs).find((event) => event.type === "roomDetached"),
  );
  assert.equal(
    harness.netsocketWrites.filter(
      (entry) => entry.payload.type === "destroyRouterGroup",
    ).length,
    2,
  );
});

test("joinRoom fails when peer did not request identity first", async () => {
  const harness = createHarness();

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "joinRoom",
    message: { peerId: "peer-x" as Guid, room: harness.room },
  });

  const outbound = parseWsMessages(harness.fakeWs);
  const errorEvent = outbound.find((event) => event.type === "error");
  assert.ok(errorEvent);
  assert.equal(
    (errorEvent.message as { error: string }).error,
    "requestRejected",
  );
  assert.match(
    (errorEvent.message as { detail: string }).detail,
    /request requires an identified peer/,
  );
});

test("joinRoom fails when peerId does not match websocket owner", async () => {
  const harness = createHarness();

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "requestIdentity",
    message: { region: harness.region },
  });

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "joinRoom",
    message: { peerId: "different-peer" as Guid, room: harness.room },
  });

  const outbound = parseWsMessages(harness.fakeWs);
  const errorEvent = outbound.find((event) => event.type === "error");
  assert.ok(errorEvent);
  assert.equal(
    (errorEvent.message as { error: string }).error,
    "requestRejected",
  );
  assert.match(
    (errorEvent.message as { detail: string }).detail,
    /peer ownership mismatch/,
  );
});

test("leaveRoom fails when peer tries to leave a different room than current", async () => {
  const harness = createHarness();

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "requestIdentity",
    message: { region: harness.region },
  });

  const identityEvent = parseWsMessages(harness.fakeWs).find(
    (event) => event.type === "identity",
  );
  assert.ok(identityEvent);
  const peerId = (identityEvent.message as { peerId: Guid }).peerId;

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "joinRoom",
    message: { peerId, room: harness.room },
  });

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "leaveRoom",
    message: { peerId, room: "other-room" },
  });

  const outbound = parseWsMessages(harness.fakeWs);
  const errorEvent = outbound.find((event) => event.type === "error");
  assert.ok(errorEvent);
  assert.equal(
    (errorEvent.message as { error: string }).error,
    "requestRejected",
  );
  assert.match(
    (errorEvent.message as { detail: string }).detail,
    /leave a room it is not currently in/,
  );
});
