/**
 * Why this file exists:
 * - One-peer lifecycle is the smallest complete end-to-end signaling/media contract.
 * - It validates that a single participant can create/connect transports, produce media,
 *   stop/restart production, leave room, and disconnect cleanly.
 * - It also validates key invalid-order failures that should be rejected, not silently ignored.
 *
 * What this suite protects:
 * - full single-peer happy path across websocket + netsocket coordination.
 * - sequencing assumptions around ingress/egress readiness.
 * - ownership and disconnect guardrails.
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
  socket.sent.map(
    (entry) => JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

const createHarness = () => {
  const wsid = "ws-full-cycle-1" as Guid;
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const ws = createFakeWs();
  const wsClients = new Map<Guid, unknown>([[wsid, ws as unknown]]);

  const ingressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const egressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const ingress = new Map<Guid, NetSocket>([[ingressServerId, ingressSocket]]);
  const egress = new Map<Guid, NetSocket>([[egressServerId, egressSocket]]);

  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const netsocketWrites: Array<{ node: string; payload: { type: string; message: Record<string, unknown> } }> = [];
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
    wsid,
    room,
    region,
    ingressServerId,
    egressServerId,
    ingressSocket,
    egressSocket,
    ws,
    netsocketWrites,
  };
};

test(
  "single peer full cycle: identity, join, media start/stop, leave, disconnect",
  { timeout: 5000 },
  async () => {
    const h = createHarness();

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "requestIdentity",
    message: { region: h.region },
  });
  const identityMsg = parseWsMessages(h.ws).find((msg) => msg.type === "identity");
  assert.ok(identityMsg);
  const peerId = identityMsg.message.peerId as Guid;

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "joinRoom",
    message: { peerId, room: h.room },
  });

  const sctp = { OS: 1024, MIS: 1024 };
  const rtpCaps = { codecs: [], headerExtensions: [] };

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "createIngress",
    message: { peerId, room: h.room, numStreams: sctp, rtpCapabilities: rtpCaps },
  });
  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "createEgress",
    message: {
      peerId,
      room: h.room,
      numStreams: sctp,
      rtpCapabilities: rtpCaps,
      serverId: h.egressServerId,
    },
  });

  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "createdWebRTCIngressTransport",
      message: {
        originId: h.wsid,
        transportId: "ingress-transport-1" as Guid,
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
        originId: h.wsid,
        transportId: "egress-transport-1" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "connectIngress",
    message: {
      peerId,
      transportId: "ingress-transport-1" as Guid,
      dtlsParameters: {},
    },
  });
  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "connectEgress",
    message: {
      peerId,
      transportId: "egress-transport-1" as Guid,
      dtlsParameters: {},
      serverId: h.egressServerId,
    },
  });
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    { type: "connectedWebRTCIngressTransport", message: { originId: h.wsid } },
    h.ingressSocket,
  );
  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    { type: "connectedWebRTCEgressTransport", message: { originId: h.wsid } },
    h.egressSocket,
  );

  const produce = async (
    kind: "audio" | "video",
    requestId: string,
    producerId: Guid,
  ) => {
    await h.manager.incomingWebsocketSignal(h.wsid, {
      type: "produceMedia",
      message: {
        producingPeer: peerId,
        transportId: "ingress-transport-1" as Guid,
        producerOptions: { kind, rtpParameters: {}, appData: {} },
        requestId,
      },
    });
    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "createdMediaProducer",
        message: {
          originId: h.wsid,
          producerId,
          kind,
          rtpParameters: {},
          appData: {},
          requestId,
        },
      },
      h.ingressSocket,
    );
  };

  await produce("audio", "req-audio-1", "producer-audio-1" as Guid);
  await produce("video", "req-video-1", "producer-video-1" as Guid);

  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "initializedNetworkRelay",
      message: {
        originId: h.wsid,
        routerNetwork: h.room,
        producerId: "producer-video-1" as Guid,
        consumerOptions: {},
        createNetworkPipeTransport: true,
        ingressIp: "127.0.0.1",
        ingressPort: 10010,
        protocol: "udp",
        appData: {},
        egressServer: h.egressServerId,
      },
    },
    h.ingressSocket,
  );
  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "connectedNetworkRelay",
      message: {
        originId: h.wsid,
        routerNetwork: h.room,
        producerId: "producer-video-1" as Guid,
        connectedTransport: true,
        egressIp: "127.0.0.1",
        egressPort: 10011,
        protocol: "udp",
        appData: {},
        ingressServer: h.ingressServerId,
      },
    },
    h.egressSocket,
  );
  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "finalizedNetworkRelay",
      message: {
        originId: h.wsid,
        producerId: "producer-video-1" as Guid,
        routerNetwork: h.room,
        kind: "video",
        ingressIp: "127.0.0.1",
        ingressPort: 10010,
        egressIp: "127.0.0.1",
        egressPort: 10011,
        egressServer: h.egressServerId,
      },
    },
    h.ingressSocket,
  );

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "producerClose",
    message: {
      originId: h.wsid,
      producerId: "producer-audio-1" as Guid,
      mediaType: "audio",
    },
  });
  await produce("audio", "req-audio-2", "producer-audio-2" as Guid);

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "leaveRoom",
    message: { peerId, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "disconnectPeerWebsocket",
    message: { transport: h.wsid, code: 1000 },
  });

  const wsTypes = parseWsMessages(h.ws).map((msg) => msg.type);
  assert.ok(wsTypes.includes("identity"));
  assert.ok(wsTypes.includes("roomAttached"));
  assert.ok(wsTypes.includes("producedMedia"));
  assert.ok(wsTypes.includes("roomDetached"));
  assert.equal(wsTypes.filter((type) => type === "producedMedia").length, 3);
  assert.equal(wsTypes.filter((type) => type === "error").length, 0);
  assert.equal(wsTypes.filter((type) => type === "mediaAnnouncement").length, 0);
  assert.deepEqual(h.ws.closeCodes, [1000]);
  const finalPeer = h.manager.peers.get(peerId);
  assert.ok(finalPeer);
  assert.equal(finalPeer.roomState, "lobby");
  assert.equal(finalPeer.room, undefined);
  assert.equal(finalPeer.mediaState, "none");
  },
);

test(
  "single peer full cycle failure branches reject invalid order/ownership",
  { timeout: 5000 },
  async () => {
    const h = createHarness();

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "joinRoom",
    message: { peerId: "unknown-peer" as Guid, room: h.room },
  });

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "requestIdentity",
    message: { region: h.region },
  });
  const peerId = parseWsMessages(h.ws).find((msg) => msg.type === "identity")!
    .message.peerId as Guid;

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "joinRoom",
    message: { peerId, room: h.room },
  });

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "connectIngress",
    message: {
      peerId,
      transportId: "missing-ingress-transport" as Guid,
      dtlsParameters: {},
    },
  });

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "produceMedia",
    message: {
      producingPeer: peerId,
      transportId: "missing-ingress-transport" as Guid,
      producerOptions: { kind: "video", rtpParameters: {}, appData: {} },
      requestId: "req-video-before-ready",
    },
  });

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "joinRoom",
    message: { peerId: "someone-else" as Guid, room: h.room },
  });

  await h.manager.incomingWebsocketSignal(h.wsid, {
    type: "disconnectPeerWebsocket",
    message: { transport: "wrong-transport" as Guid, code: 1000 },
  });

  const errors = parseWsMessages(h.ws)
    .filter((msg) => msg.type === "error")
    .map((msg) => msg.message as { error: string; detail: string });

  assert.ok(
    errors.some((err) => err.detail.includes("request requires an identified peer")),
  );
  assert.ok(
    errors.some((err) =>
      err.detail.includes("ingress transport was not created before connect request"),
    ),
  );
  assert.ok(
    errors.some((err) => err.error === "roomEgressNotReady"),
  );
  assert.ok(
    errors.some((err) => err.detail.includes("peer ownership mismatch")),
  );
    assert.ok(
      errors.some((err) => err.detail.includes("can only close its own websocket")),
    );
  },
);
