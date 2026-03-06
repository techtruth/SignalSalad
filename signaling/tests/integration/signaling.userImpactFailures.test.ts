/**
 * Why this file exists:
 * - These are user-impact regression cases that are not reconnect-specific.
 * - They focus on real session pain points: media-server loss, duplicate delivery,
 *   out-of-order responses, room guardrails, churn during active media, and missing
 *   media-server readiness responses.
 *
 * What this suite protects:
 * - active sessions fail loud/clean when a media server is ejected.
 * - late/out-of-order media callbacks do not silently corrupt session state.
 * - duplicate user actions are rejected without invalid transitions.
 * - one peer cannot be joined to two rooms at once.
 * - join/leave churn under media lifecycle remains stable.
 * - missing egress readiness returns explicit protocol error.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import {
  getSignalingDiagnostics,
  getSignalingRuntime,
} from "./runtimeAccess.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  closeCodes: number[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

type FakeSocket = NetSocket & { endCalled?: boolean };

type SignalingRuntimeView = {
  stores: {
    serverOfflineEvents: Record<string, { reason?: string }>;
    ingressServerSockets: Map<Guid, NetSocket>;
    roomRouting: { getRoutingTable: () => Map<string, unknown> };
    sessions: { getRoomPeerCount: (room: string) => number };
    producers: {
      recordProducer: (
        producerId: Guid,
        peerId: Guid,
        room: string,
        mediaType: "audio" | "video",
        ingress?: Guid,
      ) => void;
    };
  };
  ports: {
    websocketServer: { getClients: () => Map<Guid, unknown> };
  };
};

const getRuntime = (manager: Signaling) =>
  getSignalingRuntime<SignalingRuntimeView>(manager);

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

const createSocket = (): FakeSocket =>
  ({
    remoteAddress: "127.0.0.1",
    endCalled: false,
    end() {
      this.endCalled = true;
    },
    destroy() {},
  }) as FakeSocket;

const createHarness = (peerCount = 2) => {
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const peers = Array.from({ length: peerCount }, (_, idx) => {
    const wsid = `ws-user-impact-${idx + 1}` as Guid;
    return { wsid, ws: createFakeWs() };
  });

  const wsClients = new Map<Guid, unknown>(
    peers.map((peer) => [peer.wsid, peer.ws as unknown]),
  );

  const ingressSocket = createSocket();
  const egressSocket = createSocket();
  const ingress = new Map<Guid, NetSocket>([[ingressServerId, ingressSocket]]);
  const egress = new Map<Guid, NetSocket>([[egressServerId, egressSocket]]);

  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const encoder = {
    write(_buffer: Buffer) {
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
    encoder,
    ingressServerId,
    egressServerId,
    ingressSocket,
    egressSocket,
    room,
    region,
  };
};

const identifyAndJoin = async (
  manager: Signaling,
  peer: { wsid: Guid; ws: FakeWs },
  room: string,
  region: string,
) => {
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "requestIdentity",
    message: { region },
  });
  const identity = parseWsMessages(peer.ws).find((msg) => msg.type === "identity");
  assert.ok(identity, `missing identity for ${peer.wsid}`);
  const peerId = identity.message.peerId as Guid;
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "joinRoom",
    message: { peerId, room },
  });
  return peerId;
};

test("user-impact: ejecting active egress server removes active room peers and records offline reason", async () => {
  const h = createHarness(2);

  const peerA = h.peers[0];
  const peerB = h.peers[1];
  const peerAId = await identifyAndJoin(h.manager, peerA, h.room, h.region);
  const peerBId = await identifyAndJoin(h.manager, peerB, h.room, h.region);

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "unregisterMediaServer",
      message: { mode: "egress", region: h.region, reason: "maintenance" },
    },
    h.egressSocket,
  );

  assert.equal(h.egressSocket.endCalled, true);
  assert.equal(h.manager.peers.has(peerAId), false);
  assert.equal(h.manager.peers.has(peerBId), false);
  assert.equal(
    getRuntime(h.manager).stores.serverOfflineEvents[h.egressServerId]?.reason,
    "maintenance",
  );
});

test("user-impact: late/out-of-order media callbacks after leave are ignored as recoverable drift", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, h.room, h.region);

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });

  assert.doesNotThrow(() =>
    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "createdMediaProducer",
        message: {
          originId: peer.wsid,
          producerId: "late-producer-1" as Guid,
          kind: "video",
          rtpParameters: {},
          appData: {},
          requestId: "late-request",
        },
      },
      h.ingressSocket,
    ),
  );

  assert.doesNotThrow(() =>
    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["missing-transport" as Guid]: [
            {
              id: "consumer-late-1" as Guid,
              producerId: "producer-x" as Guid,
              producerPeerId: peerId,
              kind: "video",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    ),
  );

  const diagnostics = getSignalingDiagnostics(h.manager);
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "netsocketCommand" &&
        entry.message ===
          "recoverable netsocket callback ignored: createdMediaProducer",
    ),
  );
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "netsocketCommand" &&
        entry.message ===
          "recoverable netsocket callback ignored: createdConsumer",
    ),
  );
});

test("user-impact: websocket send failure forces immediate local cleanup", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, h.room, h.region);

  peer.ws.send = () => {
    throw new Error("simulated websocket send failure");
  };

  assert.doesNotThrow(() =>
    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "createdWebRTCIngressTransport",
        message: {
          originId: peer.wsid,
          transportId: "ingress-transport-send-failure" as Guid,
          iceParameters: {},
          iceCandidates: [],
          dtlsParameters: {},
          sctpParameters: {},
        },
      },
      h.ingressSocket,
    ),
  );

  assert.equal(h.manager.peers.has(peerId), false);
  const websocketClients = getRuntime(h.manager).ports.websocketServer.getClients();
  assert.equal(websocketClients.has(peer.wsid), false);

  const diagnostics = getSignalingDiagnostics(h.manager);
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "websocketRequest" &&
        entry.message ===
          "websocket send failed; forcing local disconnect cleanup",
    ),
  );
});

test("user-impact: peer leave continues when producer-close dispatch fails", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, h.room, h.region);

  getRuntime(h.manager).stores.producers.recordProducer(
    "producer-cleanup-1" as Guid,
    peerId,
    h.room,
    "audio",
    h.ingressServerId,
  );

  getRuntime(h.manager).stores.ingressServerSockets.delete(h.ingressServerId);

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });

  const currentPeer = h.manager.peers.get(peerId);
  assert.ok(currentPeer);
  assert.equal(currentPeer.roomState, "lobby");
  assert.equal(currentPeer.mediaState, "none");

  const diagnostics = getSignalingDiagnostics(h.manager);
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "mediaServerLifecycle" &&
        entry.message === "peer teardown dispatch failed",
    ),
  );
});

test("user-impact: duplicate leave request is rejected and state remains stable", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, h.room, h.region);

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });

  const errors = parseWsMessages(peer.ws).filter((msg) => msg.type === "error");
  assert.ok(errors.some((msg) => msg.message.error === "requestRejected"));
  const currentPeer = h.manager.peers.get(peerId);
  assert.ok(currentPeer);
  assert.equal(currentPeer.roomState, "lobby");
});

test("user-impact: peer cannot join two rooms at once", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, "room-a", h.region);

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "joinRoom",
    message: { peerId, room: "room-b" },
  });

  const errors = parseWsMessages(peer.ws).filter((msg) => msg.type === "error");
  assert.ok(errors.some((msg) => msg.message.error === "requestRejected"));
  const currentPeer = h.manager.peers.get(peerId);
  assert.ok(currentPeer);
  assert.equal(currentPeer.room, "room-a");
  assert.equal(currentPeer.roomState, "joined");
});

test("user-impact: joinRoom netsocket dispatch failure keeps peer in lobby", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "requestIdentity",
    message: { region: h.region },
  });
  const identity = parseWsMessages(peer.ws).find((msg) => msg.type === "identity");
  assert.ok(identity);
  const peerId = identity.message.peerId as Guid;

  let shouldFail = true;
  h.encoder.write = (_buffer: Buffer) => {
    if (shouldFail) {
      shouldFail = false;
      throw new Error("simulated join dispatch failure");
    }
    return true;
  };

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "joinRoom",
    message: { peerId, room: h.room },
  });

  const currentPeer = h.manager.peers.get(peerId);
  assert.ok(currentPeer);
  assert.equal(currentPeer.roomState, "lobby");
  assert.equal(currentPeer.room, undefined);
  assert.equal(
    getRuntime(h.manager).stores.sessions.getRoomPeerCount(h.room),
    0,
  );
  assert.equal(
    getRuntime(h.manager).stores.roomRouting.getRoutingTable().has(h.room),
    false,
  );
});

test("user-impact: leave/rejoin churn around active media remains stable", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, h.room, h.region);

  const markReady = () => {
    const p = h.manager.peers.get(peerId);
    assert.ok(p);
    h.manager.peers.set(peerId, {
      ...p,
      mediaState: "ready",
      deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
    });
  };

  // First media cycle.
  markReady();
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdWebRTCIngressTransport",
      message: {
        originId: peer.wsid,
        transportId: "ingress-transport-1" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.ingressSocket,
  );
  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "produceMedia",
    message: {
      producingPeer: peerId,
      transportId: "ingress-transport-1" as Guid,
      producerOptions: { kind: "audio", rtpParameters: {}, appData: {} },
      requestId: "req-audio-1",
    },
  });
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdMediaProducer",
      message: {
        originId: peer.wsid,
        producerId: "producer-audio-1" as Guid,
        kind: "audio",
        rtpParameters: {},
        appData: {},
        requestId: "req-audio-1",
      },
    },
    h.ingressSocket,
  );

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "joinRoom",
    message: { peerId, room: h.room },
  });

  // Second media cycle after churn.
  markReady();
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdWebRTCIngressTransport",
      message: {
        originId: peer.wsid,
        transportId: "ingress-transport-2" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.ingressSocket,
  );
  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "produceMedia",
    message: {
      producingPeer: peerId,
      transportId: "ingress-transport-2" as Guid,
      producerOptions: { kind: "video", rtpParameters: {}, appData: {} },
      requestId: "req-video-2",
    },
  });
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdMediaProducer",
      message: {
        originId: peer.wsid,
        producerId: "producer-video-2" as Guid,
        kind: "video",
        rtpParameters: {},
        appData: {},
        requestId: "req-video-2",
      },
    },
    h.ingressSocket,
  );

  const messages = parseWsMessages(peer.ws);
  const producedCount = messages.filter((msg) => msg.type === "producedMedia").length;
  const errorCodes = messages
    .filter((msg) => msg.type === "error")
    .map((msg) => String(msg.message.error));
  assert.equal(producedCount, 2);
  assert.ok(errorCodes.every((code) => code === "roomEgressNotReady"));
});

test("user-impact: rejoining peer receives roomEgressReady again after leave", async () => {
  const h = createHarness(2);
  const peerA = h.peers[0];
  const peerB = h.peers[1];

  const peerAId = await identifyAndJoin(h.manager, peerA, h.room, h.region);
  const peerBId = await identifyAndJoin(h.manager, peerB, h.room, h.region);
  assert.ok(peerAId);

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: peerA.wsid,
        transportId: "egress-transport-a-1" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );
  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: peerB.wsid,
        transportId: "egress-transport-b-1" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  const initialReadyCount = parseWsMessages(peerB.ws).filter(
    (msg) => msg.type === "roomEgressReady",
  ).length;
  assert.ok(initialReadyCount >= 1);

  await h.manager.incomingWebsocketSignal(peerB.wsid, {
    type: "leaveRoom",
    message: { peerId: peerBId, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(peerB.wsid, {
    type: "joinRoom",
    message: { peerId: peerBId, room: h.room },
  });

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: peerB.wsid,
        transportId: "egress-transport-b-2" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  const readyCountAfterRejoin = parseWsMessages(peerB.ws).filter(
    (msg) => msg.type === "roomEgressReady",
  ).length;
  assert.ok(
    readyCountAfterRejoin >= initialReadyCount + 1,
    `expected roomEgressReady to be re-sent after rejoin (before=${initialReadyCount}, after=${readyCountAfterRejoin})`,
  );
});

test("user-impact: stale transport disconnect after leave/rejoin does not block video publish", async () => {
  const h = createHarness(1);
  const peer = h.peers[0];
  const peerId = await identifyAndJoin(h.manager, peer, h.room, h.region);

  // Initial transport mappings that belong to the first room session.
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdWebRTCIngressTransport",
      message: {
        originId: peer.wsid,
        transportId: "ingress-transport-old" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.ingressSocket,
  );
  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: peer.wsid,
        transportId: "egress-transport-old" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "joinRoom",
    message: { peerId, room: h.room },
  });

  // New session setup after rejoin.
  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "createIngress",
    message: {
      peerId,
      room: h.room,
      numStreams: { OS: 1024, MIS: 1024 },
      rtpCapabilities: { codecs: [], headerExtensions: [] },
    },
  });
  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: peer.wsid,
        transportId: "egress-transport-new" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  // Late disconnect for stale transport from the previous room session.
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "disconnectedWebRTCTransport",
      message: {
        transportId: "ingress-transport-old" as Guid,
        originId: peer.wsid,
        direction: "ingress",
      },
    },
    h.ingressSocket,
  );

  await h.manager.incomingWebsocketSignal(peer.wsid, {
    type: "produceMedia",
    message: {
      producingPeer: peerId,
      transportId: "ingress-transport-new" as Guid,
      producerOptions: { kind: "video", rtpParameters: {}, appData: {} },
      requestId: "req-video-rejoin",
    },
  });
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdMediaProducer",
      message: {
        originId: peer.wsid,
        producerId: "producer-video-rejoin" as Guid,
        kind: "video",
        rtpParameters: {},
        appData: {},
        requestId: "req-video-rejoin",
      },
    },
    h.ingressSocket,
  );

  const messages = parseWsMessages(peer.ws);
  const producedMedia = messages.filter(
    (msg) =>
      msg.type === "producedMedia" &&
      msg.message.requestId === "req-video-rejoin",
  );
  const errors = messages
    .filter((msg) => msg.type === "error")
    .map((msg) => String(msg.message.error));
  assert.equal(producedMedia.length, 1);
  assert.ok(!errors.includes("requestRejected"));

  const currentPeer = h.manager.peers.get(peerId);
  assert.ok(currentPeer);
  assert.equal(currentPeer.mediaState, "ready");

  const diagnostics = getSignalingDiagnostics(h.manager);
  assert.equal(
    diagnostics.some(
      (entry) =>
        entry.category === "transportLifecycle" &&
        entry.message === "disconnected transport had no peer mapping",
    ),
    false,
  );
});

test("user-impact: missing egress readiness returns explicit roomEgressNotReady error", async () => {
  const h = createHarness(2);
  const peerAId = await identifyAndJoin(h.manager, h.peers[0], h.room, h.region);
  await identifyAndJoin(h.manager, h.peers[1], h.room, h.region);

  await h.manager.incomingWebsocketSignal(h.peers[0].wsid, {
    type: "requestRoomVideo",
    message: { requestingPeer: peerAId },
  });

  const errors = parseWsMessages(h.peers[0].ws).filter((msg) => msg.type === "error");
  assert.ok(errors.some((msg) => msg.message.error === "roomEgressNotReady"));
});
