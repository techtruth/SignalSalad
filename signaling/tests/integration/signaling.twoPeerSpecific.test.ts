/**
 * Why this file exists:
 * - Two peers are the first topology where inter-peer effects matter.
 * - It validates that join notifications, duplicate join rejection, and media fanout semantics
 *   work across distinct websocket participants.
 * - This catches regressions where one peer sees stale room view or incorrect fanout behavior.
 *
 * What this suite protects:
 * - second join room discovery/notification behavior.
 * - duplicate join request rejection.
 * - two-peer full-cycle behavior including media announcement and departure flow.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import { getSignalingRuntime } from "./runtimeAccess.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  closeCodes: number[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

type SignalingRuntimeView = {
  services: {
    peerMediaSession: {
      createConsumerPayload: (
        originId: Guid,
        producerId: string,
        kind: "video" | "audio",
        egressId: string,
      ) => Array<{ consumerTransports: string[] }>;
    };
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

const createHarness = () => {
  const wsidA = "ws-peer-a" as Guid;
  const wsidB = "ws-peer-b" as Guid;
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
  const netsocketWrites: Array<{
    destination: Guid;
    payload: { type: string; message: Record<string, unknown> };
  }> = [];
  const ingressEncoder = {
    write(buffer: Buffer) {
      netsocketWrites.push({
        destination: ingressServerId,
        payload: JSON.parse(buffer.toString()),
      });
      return true;
    },
  } as unknown as Transform;
  const egressEncoder = {
    write(buffer: Buffer) {
      netsocketWrites.push({
        destination: egressServerId,
        payload: JSON.parse(buffer.toString()),
      });
      return true;
    },
  } as unknown as Transform;
  nsEncoders.set(ingressSocket, ingressEncoder);
  nsEncoders.set(egressSocket, egressEncoder);

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
    ingressServerId,
    egressServerId,
    ingressSocket,
    egressSocket,
    netsocketWrites,
  };
};

const setupJoinedPeers = async (h: ReturnType<typeof createHarness>) => {
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

  return { peerIdA, peerIdB };
};

test("two-peer specific behavior: second join sees existing peer and first peer is notified", async () => {
  const h = createHarness();
  const { peerIdA, peerIdB } = await setupJoinedPeers(h);
  const roomAttachB = parseWsMessages(h.wsB).find(
    (msg) => msg.type === "roomAttached",
  );
  assert.ok(roomAttachB);
  const roomPeers = roomAttachB.message.roomPeers as Guid[];
  assert.ok(roomPeers.includes(peerIdA));

  const peerConnectedForA = parseWsMessages(h.wsA).find(
    (msg) =>
      msg.type === "peerConnected" &&
      (msg.message.peerId as Guid | undefined) === peerIdB,
  );
  assert.ok(peerConnectedForA);

  // Minimal media-specific path for 2-peer behavior:
  // - mark both joined peers media-ready
  // - ensure producer->consumer fanout plans for the other peer
  // - ensure created consumer notification lands on the correct websocket
  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: h.wsidA,
        transportId: "egress-a" as Guid,
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
        originId: h.wsidB,
        transportId: "egress-b" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  const peerA = h.manager.peers.get(peerIdA)!;
  const peerB = h.manager.peers.get(peerIdB)!;
  h.manager.peers.set(peerIdA, {
    ...peerA,
    mediaState: "ready",
    deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
  } as typeof peerA);
  h.manager.peers.set(peerIdB, {
    ...peerB,
    mediaState: "ready",
    deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
  } as typeof peerB);

  const plannedConsumerMessages = getRuntime(
    h.manager,
  ).services.peerMediaSession.createConsumerPayload(
    h.wsidA,
    "producer-video-a",
    "video",
    h.egressServerId,
  );
  assert.equal(plannedConsumerMessages.length, 1);
  assert.deepEqual(plannedConsumerMessages[0].consumerTransports, ["egress-b"]);

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdConsumer",
      message: {
        ["egress-b" as Guid]: [
          {
            id: "consumer-b-video-a" as Guid,
            producerId: "producer-video-a" as Guid,
            producerPeerId: peerIdA,
            kind: "video",
            rtpParameters: {},
            appData: {},
          },
        ],
      },
    },
    h.egressSocket,
  );

  const mediaAnnouncementForB = parseWsMessages(h.wsB).find(
    (msg) => msg.type === "mediaAnnouncement",
  );
  assert.ok(mediaAnnouncementForB);
  const mediaAnnouncementForA = parseWsMessages(h.wsA).find(
    (msg) => msg.type === "mediaAnnouncement",
  );
  assert.equal(mediaAnnouncementForA, undefined);
});

test("two-peer duplicate join request is rejected", async () => {
  const h = createHarness();
  const { peerIdB } = await setupJoinedPeers(h);

  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "joinRoom",
    message: { peerId: peerIdB, room: h.room },
  });

  const errors = parseWsMessages(h.wsB).filter((msg) => msg.type === "error");
  assert.ok(
    errors.some(
      (msg) => msg.message.error === "requestRejected",
    ),
  );
});

test("two-peer happy path full cycle: identity, join, media fanout, leave, disconnect", async () => {
  const h = createHarness();
  const { peerIdA, peerIdB } = await setupJoinedPeers(h);

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: h.wsidA,
        transportId: "egress-a-full-cycle" as Guid,
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
        originId: h.wsidB,
        transportId: "egress-b-full-cycle" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  const peerA = h.manager.peers.get(peerIdA)!;
  const peerB = h.manager.peers.get(peerIdB)!;
  h.manager.peers.set(peerIdA, {
    ...peerA,
    mediaState: "ready",
    deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
  } as typeof peerA);
  h.manager.peers.set(peerIdB, {
    ...peerB,
    mediaState: "ready",
    deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
  } as typeof peerB);

  const plannedConsumerMessages = getRuntime(
    h.manager,
  ).services.peerMediaSession.createConsumerPayload(
    h.wsidA,
    "producer-video-a-full-cycle",
    "video",
    h.egressServerId,
  );
  assert.equal(plannedConsumerMessages.length, 1);
  assert.deepEqual(plannedConsumerMessages[0].consumerTransports, ["egress-b-full-cycle"]);

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdConsumer",
      message: {
        ["egress-b-full-cycle" as Guid]: [
          {
            id: "consumer-b-video-a-full-cycle" as Guid,
            producerId: "producer-video-a-full-cycle" as Guid,
            producerPeerId: peerIdA,
            kind: "video",
            rtpParameters: {},
            appData: {},
          },
        ],
      },
    },
    h.egressSocket,
  );

  const bMessageTypes = parseWsMessages(h.wsB).map((msg) => msg.type);
  assert.ok(bMessageTypes.includes("mediaAnnouncement"));

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "leaveRoom",
    message: { peerId: peerIdA, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "disconnectPeerWebsocket",
    message: { transport: h.wsidA, code: 1000 },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "leaveRoom",
    message: { peerId: peerIdB, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "disconnectPeerWebsocket",
    message: { transport: h.wsidB, code: 1000 },
  });

  const aMessageTypes = parseWsMessages(h.wsA).map((msg) => msg.type);
  const finalBMessageTypes = parseWsMessages(h.wsB).map((msg) => msg.type);

  assert.ok(aMessageTypes.includes("identity"));
  assert.ok(aMessageTypes.includes("roomAttached"));
  assert.ok(aMessageTypes.includes("roomDetached"));
  assert.ok(finalBMessageTypes.includes("identity"));
  assert.ok(finalBMessageTypes.includes("roomAttached"));
  assert.ok(finalBMessageTypes.includes("roomDetached"));
  assert.ok(finalBMessageTypes.includes("peerDisconnected"));
  assert.deepEqual(h.wsA.closeCodes, [1000]);
  assert.deepEqual(h.wsB.closeCodes, [1000]);
});
