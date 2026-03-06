/**
 * Why this file exists:
 * - Ordering bugs often appear only when messages arrive in a different sequence than expected.
 * - Two peers are enough to model ordering variance while still keeping assertions readable.
 * - This suite ensures the system converges under staggered identity/join and rejects
 *   out-of-order media requests with explicit error semantics.
 *
 * What this suite protects:
 * - timing skew in identity/join workflows.
 * - deterministic convergence to connected room state.
 * - explicit protocol response for "request media before egress readiness."
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
  send: (payload: string) => void;
  close: (code: number) => void;
};

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createFakeWs = (): FakeWs => ({
  sent: [],
  send(payload: string) {
    this.sent.push(payload);
  },
  close(_code: number) {},
});

const parseWsMessages = (socket: FakeWs) =>
  socket.sent.map(
    (entry) => JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

const createHarness = () => {
  const wsidA = "ws-peer-a-timing" as Guid;
  const wsidB = "ws-peer-b-timing" as Guid;
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const wsA = createFakeWs();
  const wsB = createFakeWs();
  const wsClients = new Map<Guid, unknown>([
    [wsidA, wsA as unknown],
    [wsidB, wsB as unknown],
  ]);

  const ingressSocket = { remoteAddress: "127.0.0.1" } as NetSocket;
  const egressSocket = { remoteAddress: "127.0.0.1" } as NetSocket;
  const ingress = new Map<Guid, NetSocket>([[ingressServerId, ingressSocket]]);
  const egress = new Map<Guid, NetSocket>([[egressServerId, egressSocket]]);

  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const encoder = { write(_buffer: Buffer) { return true; } } as unknown as Transform;
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

  manager.incomingNetsocketCommand(
    ingressServerId,
    { type: "registerMediaServer", message: { registrationId: ingressServerId, mode: "ingress", region } },
    ingressSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    { type: "registerMediaServer", message: { registrationId: egressServerId, mode: "egress", region } },
    egressSocket,
  );

  return {
    manager,
    wsidA,
    wsidB,
    wsA,
    wsB,
    room,
    region,
  };
};

test(
  "twopeertiming: staggered identity/join order still converges to connected peers",
  { timeout: 5000 },
  async () => {
    const h = createHarness();

    await Promise.all([
      (async () => {
        await wait(0);
        await h.manager.incomingWebsocketSignal(h.wsidA, {
          type: "requestIdentity",
          message: { region: h.region },
        });
      })(),
      (async () => {
        await wait(15);
        await h.manager.incomingWebsocketSignal(h.wsidB, {
          type: "requestIdentity",
          message: { region: h.region },
        });
      })(),
    ]);

    const peerIdA = parseWsMessages(h.wsA).find((msg) => msg.type === "identity")!
      .message.peerId as Guid;
    const peerIdB = parseWsMessages(h.wsB).find((msg) => msg.type === "identity")!
      .message.peerId as Guid;

    await Promise.all([
      (async () => {
        await wait(0);
        await h.manager.incomingWebsocketSignal(h.wsidB, {
          type: "joinRoom",
          message: { peerId: peerIdB, room: h.room },
        });
      })(),
      (async () => {
        await wait(20);
        await h.manager.incomingWebsocketSignal(h.wsidA, {
          type: "joinRoom",
          message: { peerId: peerIdA, room: h.room },
        });
      })(),
    ]);

    const wsAEvents = parseWsMessages(h.wsA);
    const wsBEvents = parseWsMessages(h.wsB);

    assert.ok(wsAEvents.find((msg) => msg.type === "roomAttached"));
    assert.ok(wsBEvents.find((msg) => msg.type === "roomAttached"));
    assert.ok(wsBEvents.find((msg) => msg.type === "peerConnected"));
    const roomAttachA = wsAEvents.find((msg) => msg.type === "roomAttached");
    assert.ok(roomAttachA);
    const roomPeersA = roomAttachA.message.roomPeers as Guid[];
    assert.ok(roomPeersA.includes(peerIdB));

    const errors = [...wsAEvents, ...wsBEvents].filter((msg) => msg.type === "error");
    assert.equal(errors.length, 0);
  },
);

test(
  "twopeertiming: out-of-order media request before egress readiness returns roomEgressNotReady",
  { timeout: 5000 },
  async () => {
    const h = createHarness();

    await h.manager.incomingWebsocketSignal(h.wsidA, {
      type: "requestIdentity",
      message: { region: h.region },
    });
    await h.manager.incomingWebsocketSignal(h.wsidB, {
      type: "requestIdentity",
      message: { region: h.region },
    });

    const peerIdA = parseWsMessages(h.wsA).find((msg) => msg.type === "identity")!
      .message.peerId as Guid;
    const peerIdB = parseWsMessages(h.wsB).find((msg) => msg.type === "identity")!
      .message.peerId as Guid;

    await h.manager.incomingWebsocketSignal(h.wsidA, {
      type: "joinRoom",
      message: { peerId: peerIdA, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(h.wsidB, {
      type: "joinRoom",
      message: { peerId: peerIdB, room: h.room },
    });

    await h.manager.incomingWebsocketSignal(h.wsidB, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerIdB },
    });

    const errors = parseWsMessages(h.wsB).filter((msg) => msg.type === "error");
    assert.ok(errors.some((msg) => msg.message.error === "roomEgressNotReady"));
  },
);
