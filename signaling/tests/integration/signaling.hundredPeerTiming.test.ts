/**
 * Why this file exists:
 * - 100 peers is a local stress layer to expose ordering and branching regressions that
 *   are unlikely to appear in small topologies.
 * - It keeps everything in-process (no browser/media RTP) while heavily exercising
 *   signaling state transitions and guardrails.
 *
 * What this suite protects:
 * - large-cardinality identity/join convergence.
 * - complex traffic sequencing at moderate scale: media requests, leave/rejoin churn,
 *   graceful leave+disconnect and abrupt disconnect interleaving.
 * - protocol stability with explicit expected failure categories only.
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

const waitForIdentity = async (socket: FakeWs, timeoutMs = 1000): Promise<Guid> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const identity = parseWsMessages(socket).find((msg) => msg.type === "identity");
    if (identity) {
      return identity.message.peerId as Guid;
    }
    await wait(5);
  }
  throw new Error("Timed out waiting for identity message");
};

const withSilencedLogs = async <T>(fn: () => Promise<T>): Promise<T> => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};

const createHarness = (peerCount: number) => {
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const peers = Array.from({ length: peerCount }, (_, idx) => {
    const wsid = `ws-peer-${idx + 1}-timing100` as Guid;
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

  return { manager, peers, region, room };
};

test(
  "hundred-peer timing: staggered identity/join converges without protocol errors",
  { timeout: 20000 },
  async () => {
    await withSilencedLogs(async () => {
      const h = createHarness(100);
      const peerIds = new Map<Guid, Guid>();

      await Promise.all(
        h.peers.map((peer, idx) =>
          (async () => {
            await wait((idx * 7) % 41);
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "requestIdentity",
              message: { region: h.region },
            });
          })(),
        ),
      );

      for (const peer of h.peers) {
        const identity = parseWsMessages(peer.ws).find((msg) => msg.type === "identity");
        assert.ok(identity);
        peerIds.set(peer.wsid, identity.message.peerId as Guid);
      }

      const joinOrder = h.peers
        .map((_peer, idx) => idx)
        .sort((a, b) => ((a * 37) % 101) - ((b * 37) % 101));
      await Promise.all(
        joinOrder.map((idx, position) =>
          (async () => {
            await wait((position * 11) % 53);
            const peer = h.peers[idx];
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
      assert.equal(allEvents.filter((msg) => msg.type === "roomAttached").length, 100);
      assert.equal(allEvents.filter((msg) => msg.type === "peerConnected").length, 4950);
    });
  },
);

test(
  "complex traffic sequencing: mixed media requests, churn, and departures remain deterministic",
  { timeout: 20000 },
  async () => {
    await withSilencedLogs(async () => {
      const h = createHarness(30);
      const peerIds = new Map<Guid, Guid>();

      await Promise.all(
        h.peers.map((peer, idx) =>
          (async () => {
            await wait((idx * 3) % 17);
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "requestIdentity",
              message: { region: h.region },
            });
          })(),
        ),
      );

      for (const peer of h.peers) {
        const peerId = await waitForIdentity(peer.ws);
        peerIds.set(peer.wsid, peerId);
      }

      await Promise.all(
        h.peers
          .map((_peer, idx) => idx)
          .sort((a, b) => ((a * 19) % 31) - ((b * 19) % 31))
          .map((idx, position) =>
            (async () => {
              await wait((position * 5) % 23);
              const peer = h.peers[idx];
              await h.manager.incomingWebsocketSignal(peer.wsid, {
                type: "joinRoom",
                message: { peerId: peerIds.get(peer.wsid), room: h.room },
              });
            })(),
          ),
      );

      const mediaPeers = h.peers.slice(0, 10);
      const churnPeers = h.peers.slice(10, 20);
      const departurePeers = h.peers.slice(20, 30);
      const mediaRequestPeers = [...mediaPeers, ...churnPeers];
      const roomEgressNotReadyCode = "roomEgressNotReady";

      // Wave 1: initial independent media requests.
      await Promise.all(
        mediaRequestPeers.map((peer, idx) =>
          (async () => {
            await wait((idx * 5) % 19);
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "requestRoomVideo",
              message: { requestingPeer: peerIds.get(peer.wsid) },
            });
          })(),
        ),
      );

      for (const peer of mediaRequestPeers) {
        const errors = parseWsMessages(peer.ws).filter(
          (msg) =>
            msg.type === "error" &&
            String(msg.message.error) === roomEgressNotReadyCode,
        );
        assert.ok(
          errors.length >= 1,
          `expected at least one ${roomEgressNotReadyCode} for ${peer.wsid}`,
        );
      }

      // Wave 2: churn cohort leaves, rejoins, then requests media again.
      await Promise.all(
        churnPeers.map((peer, idx) =>
          (async () => {
            await wait((idx * 7) % 29);
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

      for (const peer of churnPeers) {
        const messages = parseWsMessages(peer.ws);
        const roomAttachedCount = messages.filter(
          (msg) => msg.type === "roomAttached",
        ).length;
        assert.ok(
          roomAttachedCount >= 2,
          `expected two roomAttached events for ${peer.wsid}`,
        );
      }

      // Wave 3: independent departures across graceful and abrupt cohorts.
      const gracefulPeers = departurePeers.filter((_peer, idx) => idx % 2 === 0);
      const abruptPeers = departurePeers.filter((_peer, idx) => idx % 2 === 1);

      await Promise.all(
        [
          ...gracefulPeers.map((peer, idx) =>
            (async () => {
              await wait((idx * 11) % 31);
              await h.manager.incomingWebsocketSignal(peer.wsid, {
                type: "leaveRoom",
                message: { peerId: peerIds.get(peer.wsid), room: h.room },
              });
              await h.manager.incomingWebsocketSignal(peer.wsid, {
                type: "disconnectPeerWebsocket",
                message: { transport: peer.wsid, code: 1000 },
              });
            })(),
          ),
          ...abruptPeers.map((peer, idx) =>
            (async () => {
              await wait((idx * 13) % 37);
              await h.manager.incomingWebsocketSignal(peer.wsid, {
                type: "disconnectPeerWebsocket",
                message: { transport: peer.wsid, code: 1000 },
              });
            })(),
          ),
        ],
      );

      const allEvents = h.peers.flatMap((peer) => parseWsMessages(peer.ws));
      const errorCodes = allEvents
        .filter((msg) => msg.type === "error")
        .map((msg) => String(msg.message.error));
      assert.ok(errorCodes.every((code) => code === roomEgressNotReadyCode));
      assert.ok(errorCodes.length >= mediaRequestPeers.length);

      // Only departure cohorts should have websocket closes in this scenario:
      // - gracefulPeers: leave + explicit disconnect
      // - abruptPeers: explicit disconnect
      const disconnectedWsids = new Set<Guid>([
        ...gracefulPeers.map((peer) => peer.wsid),
        ...abruptPeers.map((peer) => peer.wsid),
      ]);
      const stillConnectedPeers = h.peers.filter((peer) => !disconnectedWsids.has(peer.wsid));
      const disconnectedPeers = h.peers.filter((peer) => disconnectedWsids.has(peer.wsid));

      assert.ok(disconnectedPeers.every((peer) => peer.ws.closeCodes.includes(1000)));
      assert.ok(stillConnectedPeers.every((peer) => peer.ws.closeCodes.length === 0));

      const stillConnectedEvents = stillConnectedPeers.flatMap((peer) =>
        parseWsMessages(peer.ws),
      );
      const peerDisconnectedEvents = stillConnectedEvents.filter(
        (msg) => msg.type === "peerDisconnected",
      );
      assert.ok(peerDisconnectedEvents.length >= 1);
    });
  },
);
