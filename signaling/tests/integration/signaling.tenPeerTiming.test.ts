/**
 * Why this file exists:
 * - Moderate-scale timing variance can expose race assumptions not visible in 1-3 peer tests.
 * - This suite does not attempt full E2E media load; it stress-tests control-plane sequencing
 *   with larger peer cardinality and mixed departure styles.
 * - The goal is robust convergence and protocol stability under interleaving operations.
 *
 * What this suite protects:
 * - 10-peer staggered identity/join convergence with expected connection event volume.
 * - mixed graceful leave + abrupt disconnect behavior without protocol-level errors.
 * - clean websocket termination in high-variance ordering.
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

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  socket.sent.map(
    (entry) => JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

const createHarness = (peerCount: number) => {
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const peers = Array.from({ length: peerCount }, (_, idx) => {
    const wsid = `ws-peer-${idx + 1}-timing10` as Guid;
    const ws = createFakeWs();
    return { wsid, ws };
  });

  const wsClients = new Map<Guid, unknown>(
    peers.map((peer) => [peer.wsid, peer.ws as unknown]),
  );

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
    peers,
    room,
    region,
  };
};

test(
  "ten-peer timing: staggered identity/join converges with expected connection events",
  { timeout: 10000 },
  async () => {
    const h = createHarness(10);
    const identityOffsets = [0, 14, 2, 18, 7, 3, 22, 10, 5, 16];
    const joinOrder = [3, 0, 7, 1, 9, 4, 2, 8, 5, 6];
    const joinOffsets = [4, 0, 12, 2, 18, 6, 10, 8, 14, 16];

    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait(identityOffsets[idx]);
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "requestIdentity",
            message: { region: h.region },
          });
        })(),
      ),
    );

    const peerIds = new Map<Guid, Guid>();
    for (const peer of h.peers) {
      const identity = parseWsMessages(peer.ws).find((msg) => msg.type === "identity");
      assert.ok(identity);
      peerIds.set(peer.wsid, identity.message.peerId as Guid);
    }

    await Promise.all(
      joinOrder.map((peerIdx, idx) =>
        (async () => {
          await wait(joinOffsets[idx]);
          const peer = h.peers[peerIdx];
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "joinRoom",
            message: { peerId: peerIds.get(peer.wsid), room: h.room },
          });
        })(),
      ),
    );

    const allEvents = h.peers.flatMap((peer) => parseWsMessages(peer.ws));
    const errors = allEvents.filter((msg) => msg.type === "error");
    assert.equal(errors.length, 0);

    const roomAttachedCount = allEvents.filter((msg) => msg.type === "roomAttached").length;
    assert.equal(roomAttachedCount, 10);

    // Each pair contributes one peerConnected event (to the peer already in the room).
    const peerConnectedCount = allEvents.filter((msg) => msg.type === "peerConnected").length;
    assert.equal(peerConnectedCount, 45);
  },
);

test(
  "ten-peer timing: branched mixed behavior exercises independent media-request, leave/rejoin, and disconnect waves",
  { timeout: 10000 },
  async () => {
    const h = createHarness(10);
    const peerIds = new Map<Guid, Guid>();

    for (const peer of h.peers) {
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "requestIdentity",
        message: { region: h.region },
      });
      const identity = parseWsMessages(peer.ws).find((msg) => msg.type === "identity");
      assert.ok(identity);
      peerIds.set(peer.wsid, identity.message.peerId as Guid);
    }

    for (const peer of h.peers) {
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "joinRoom",
        message: { peerId: peerIds.get(peer.wsid), room: h.room },
      });
    }

    // Wave 1: everyone requests room media while joined.
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 5) % 13);
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "requestRoomVideo",
            message: { requestingPeer: peerIds.get(peer.wsid) },
          });
        })(),
      ),
    );

    // Wave 2: subset leaves, rejoins, and requests media again.
    const rejoinPeers = h.peers.slice(0, 5);
    await Promise.all(
      rejoinPeers.map((peer, idx) =>
        (async () => {
          await wait((idx * 7) % 17);
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "leaveRoom",
            message: { peerId: peerIds.get(peer.wsid), room: h.room },
          });
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "joinRoom",
            message: { peerId: peerIds.get(peer.wsid), room: h.room },
          });
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "requestRoomVideo",
            message: { requestingPeer: peerIds.get(peer.wsid) },
          });
        })(),
      ),
    );

    // Wave 3: mixed graceful + abrupt disconnects.
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 11) % 19);
          if (idx % 2 === 1) {
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "leaveRoom",
              message: { peerId: peerIds.get(peer.wsid), room: h.room },
            });
          }
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "disconnectPeerWebsocket",
            message: { transport: peer.wsid, code: 1000 },
          });
        })(),
      ),
    );

    const allEvents = h.peers.flatMap((peer) => parseWsMessages(peer.ws));
    const errors = allEvents.filter((msg) => msg.type === "error");
    const errorCodes = errors.map((msg) => String(msg.message.error));
    assert.ok(errorCodes.every((code) => code === "roomEgressNotReady"));
    assert.ok(errorCodes.includes("roomEgressNotReady"));

    const disconnectedCount = allEvents.filter((msg) => msg.type === "peerDisconnected").length;
    assert.ok(disconnectedCount > 0);
    assert.ok(h.peers.every((peer) => peer.ws.closeCodes.includes(1000)));
  },
);
