/**
 * Why this file exists:
 * - Existing suites validate individual slices of behavior.
 * - This suite validates one end-to-end user journey with realistic sequencing:
 *   identity, join, transport setup, publish/consume actions, peer controls,
 *   leave/rejoin, and cleanup.
 *
 * What this suite protects:
 * - full join-to-exit control flow across websocket + netsocket channels.
 * - media actions after room join (produce, consume, mute, producer close).
 * - leave/rejoin continuity with fresh transports and renewed media access.
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

type HarnessPeer = {
  wsid: Guid;
  ws: FakeWs;
};

type NetsocketWrite = {
  destination: Guid;
  signal: {
    node: string;
    payload: {
      type: string;
      message: Record<string, unknown>;
    };
  };
};

type CreateConsumerMessage = {
  kind: "audio" | "video";
  consumerTransports: Guid[];
  producerIds: Array<Record<string, Guid[]>>;
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

const countWsMessages = (socket: FakeWs, type: string) =>
  parseWsMessages(socket).filter((msg) => msg.type === type).length;

const getLastWsMessage = (socket: FakeWs, type: string) => {
  const matches = parseWsMessages(socket).filter((msg) => msg.type === type);
  return matches[matches.length - 1];
};

const getCreateConsumerMessages = (
  writes: NetsocketWrite[],
): CreateConsumerMessage[] =>
  writes
    .filter((entry) => entry.signal.payload.type === "createConsumer")
    .map((entry) => entry.signal.payload.message as unknown as CreateConsumerMessage);

const createConsumerIncludesProducer = (
  message: CreateConsumerMessage,
  producerId: Guid,
) =>
  message.producerIds.some((producerGroup) =>
    Object.values(producerGroup).some((ids) => ids.includes(producerId)),
  );

const createHarness = () => {
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const peers: HarnessPeer[] = [
    { wsid: "ws-journey-a" as Guid, ws: createFakeWs() },
    { wsid: "ws-journey-b" as Guid, ws: createFakeWs() },
  ];

  const wsClients = new Map<Guid, unknown>(
    peers.map((peer) => [peer.wsid, peer.ws as unknown]),
  );

  const ingressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const egressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const ingress = new Map<Guid, NetSocket>([[ingressServerId, ingressSocket]]);
  const egress = new Map<Guid, NetSocket>([[egressServerId, egressSocket]]);

  const netsocketWrites: NetsocketWrite[] = [];
  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const ingressEncoder = {
    write(buffer: Buffer) {
      netsocketWrites.push({
        destination: ingressServerId,
        signal: JSON.parse(buffer.toString()),
      });
      return true;
    },
  } as unknown as Transform;
  const egressEncoder = {
    write(buffer: Buffer) {
      netsocketWrites.push({
        destination: egressServerId,
        signal: JSON.parse(buffer.toString()),
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
    peers,
    room,
    region,
    ingressServerId,
    egressServerId,
    ingressSocket,
    egressSocket,
    netsocketWrites,
  };
};

const identifyPeer = async (manager: Signaling, peer: HarnessPeer, region: string) => {
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "requestIdentity",
    message: { region },
  });
  const identity = getLastWsMessage(peer.ws, "identity");
  assert.ok(identity, `missing identity for ${peer.wsid}`);
  return identity.message.peerId as Guid;
};

const joinPeer = async (
  manager: Signaling,
  peer: HarnessPeer,
  peerId: Guid,
  room: string,
) => {
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "joinRoom",
    message: { peerId, room },
  });
};

const setupPeerTransports = async (params: {
  manager: Signaling;
  peer: HarnessPeer;
  peerId: Guid;
  room: string;
  ingressServerId: Guid;
  egressServerId: Guid;
  ingressSocket: NetSocket;
  egressSocket: NetSocket;
  ingressTransportId: Guid;
  egressTransportId: Guid;
}) => {
  const {
    manager,
    peer,
    peerId,
    room,
    ingressServerId,
    egressServerId,
    ingressSocket,
    egressSocket,
    ingressTransportId,
    egressTransportId,
  } = params;
  const numStreams = { OS: 1024, MIS: 1024 };
  const rtpCapabilities = { codecs: [], headerExtensions: [] };

  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "createIngress",
    message: {
      peerId,
      room,
      numStreams,
      rtpCapabilities,
    },
  });
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "createEgress",
    message: {
      peerId,
      room,
      numStreams,
      rtpCapabilities,
      serverId: egressServerId,
    },
  });

  manager.incomingNetsocketCommand(
    ingressServerId,
    {
      type: "createdWebRTCIngressTransport",
      message: {
        originId: peer.wsid,
        transportId: ingressTransportId,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    ingressSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: peer.wsid,
        transportId: egressTransportId,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    egressSocket,
  );

  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "connectIngress",
    message: {
      peerId,
      transportId: ingressTransportId,
      dtlsParameters: {},
    },
  });
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "connectEgress",
    message: {
      peerId,
      transportId: egressTransportId,
      dtlsParameters: {},
      serverId: egressServerId,
    },
  });

  manager.incomingNetsocketCommand(
    ingressServerId,
    {
      type: "connectedWebRTCIngressTransport",
      message: { originId: peer.wsid },
    },
    ingressSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    {
      type: "connectedWebRTCEgressTransport",
      message: { originId: peer.wsid },
    },
    egressSocket,
  );
};

const produceMedia = async (params: {
  manager: Signaling;
  peer: HarnessPeer;
  peerId: Guid;
  ingressServerId: Guid;
  ingressSocket: NetSocket;
  ingressTransportId: Guid;
  kind: "audio" | "video";
  producerId: Guid;
  requestId: string;
}) => {
  const {
    manager,
    peer,
    peerId,
    ingressServerId,
    ingressSocket,
    ingressTransportId,
    kind,
    producerId,
    requestId,
  } = params;
  await manager.incomingWebsocketSignal(peer.wsid, {
    type: "produceMedia",
    message: {
      producingPeer: peerId,
      transportId: ingressTransportId,
      producerOptions: { kind, rtpParameters: {}, appData: {} },
      requestId,
    },
  });
  manager.incomingNetsocketCommand(
    ingressServerId,
    {
      type: "createdMediaProducer",
      message: {
        originId: peer.wsid,
        producerId,
        kind,
        rtpParameters: {},
        appData: {},
        requestId,
      },
    },
    ingressSocket,
  );
};

test(
  "full logic journey: join -> media actions -> leave/rejoin -> cleanup",
  async () => {
    const h = createHarness();
    const [peerA, peerB] = h.peers;

    const peerAId = await identifyPeer(h.manager, peerA, h.region);
    const peerBId = await identifyPeer(h.manager, peerB, h.region);

    await joinPeer(h.manager, peerA, peerAId, h.room);
    await joinPeer(h.manager, peerB, peerBId, h.room);

    await setupPeerTransports({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      room: h.room,
      ingressServerId: h.ingressServerId,
      egressServerId: h.egressServerId,
      ingressSocket: h.ingressSocket,
      egressSocket: h.egressSocket,
      ingressTransportId: "ingress-a-1" as Guid,
      egressTransportId: "egress-a-1" as Guid,
    });
    await setupPeerTransports({
      manager: h.manager,
      peer: peerB,
      peerId: peerBId,
      room: h.room,
      ingressServerId: h.ingressServerId,
      egressServerId: h.egressServerId,
      ingressSocket: h.ingressSocket,
      egressSocket: h.egressSocket,
      ingressTransportId: "ingress-b-1" as Guid,
      egressTransportId: "egress-b-1" as Guid,
    });

    const initialReadyCountB = countWsMessages(peerB.ws, "roomEgressReady");
    assert.ok(initialReadyCountB >= 1);

    await produceMedia({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      ingressServerId: h.ingressServerId,
      ingressSocket: h.ingressSocket,
      ingressTransportId: "ingress-a-1" as Guid,
      kind: "audio",
      producerId: "producer-audio-a-1" as Guid,
      requestId: "req-audio-a-1",
    });
    await produceMedia({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      ingressServerId: h.ingressServerId,
      ingressSocket: h.ingressSocket,
      ingressTransportId: "ingress-a-1" as Guid,
      kind: "video",
      producerId: "producer-video-a-1" as Guid,
      requestId: "req-video-a-1",
    });

    const writesBeforeFirstVideoRequest = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const firstVideoRequestWrites = h.netsocketWrites.slice(
      writesBeforeFirstVideoRequest,
    );
    const firstCreateConsumer = firstVideoRequestWrites.find(
      (entry) => entry.signal.payload.type === "createConsumer",
    );
    assert.ok(firstCreateConsumer);
    const firstCreateConsumerMessage = firstCreateConsumer!.signal.payload
      .message as {
      consumerTransports: Guid[];
      producerIds: Array<Record<string, Guid[]>>;
      kind: "audio" | "video";
    };
    assert.equal(firstCreateConsumerMessage.kind, "video");
    assert.deepEqual(firstCreateConsumerMessage.consumerTransports, [
      "egress-b-1" as Guid,
    ]);

    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["egress-b-1" as Guid]: [
            {
              id: "consumer-b-video-a-1" as Guid,
              producerId: "producer-video-a-1" as Guid,
              producerPeerId: peerAId,
              kind: "video",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    );
    const firstMediaAnnouncement = getLastWsMessage(peerB.ws, "mediaAnnouncement");
    assert.ok(firstMediaAnnouncement);
    const firstAnnouncementItems = firstMediaAnnouncement.message as Array<{
      producerId: Guid;
      transportId: Guid;
    }>;
    assert.equal(firstAnnouncementItems[0]?.producerId, "producer-video-a-1");

    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "mutePeer",
      message: {
        requestingPeer: peerBId,
        targetPeer: peerAId,
        scope: "client",
        muted: true,
      },
    });
    const peerMuteRequested = getLastWsMessage(peerA.ws, "peerMuteRequested");
    assert.ok(peerMuteRequested);
    assert.equal(peerMuteRequested.message.requesterPeerId, peerBId);

    const writesBeforeServerMute = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "mutePeer",
      message: {
        requestingPeer: peerBId,
        targetPeer: peerAId,
        scope: "server",
        muted: true,
      },
    });
    const serverMuteWrites = h.netsocketWrites.slice(writesBeforeServerMute);
    const setProducerPaused = serverMuteWrites.find(
      (entry) =>
        entry.destination === h.ingressServerId &&
        entry.signal.payload.type === "setProducerPaused",
    );
    assert.ok(setProducerPaused);
    assert.equal(
      setProducerPaused!.signal.payload.message.producerId,
      "producer-audio-a-1",
    );
    assert.equal(setProducerPaused!.signal.payload.message.paused, true);

    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "leaveRoom",
      message: { peerId: peerBId, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "joinRoom",
      message: { peerId: peerBId, room: h.room },
    });

    await setupPeerTransports({
      manager: h.manager,
      peer: peerB,
      peerId: peerBId,
      room: h.room,
      ingressServerId: h.ingressServerId,
      egressServerId: h.egressServerId,
      ingressSocket: h.ingressSocket,
      egressSocket: h.egressSocket,
      ingressTransportId: "ingress-b-2" as Guid,
      egressTransportId: "egress-b-2" as Guid,
    });

    const readyCountAfterRejoinB = countWsMessages(peerB.ws, "roomEgressReady");
    assert.ok(readyCountAfterRejoinB >= initialReadyCountB + 1);

    const writesBeforeSecondVideoRequest = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const secondVideoRequestWrites = h.netsocketWrites.slice(
      writesBeforeSecondVideoRequest,
    );
    const secondCreateConsumer = secondVideoRequestWrites.find(
      (entry) => entry.signal.payload.type === "createConsumer",
    );
    assert.ok(secondCreateConsumer);
    const secondCreateConsumerMessage = secondCreateConsumer!.signal.payload
      .message as {
      consumerTransports: Guid[];
    };
    assert.deepEqual(secondCreateConsumerMessage.consumerTransports, [
      "egress-b-2" as Guid,
    ]);

    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["egress-b-2" as Guid]: [
            {
              id: "consumer-b-video-a-2" as Guid,
              producerId: "producer-video-a-1" as Guid,
              producerPeerId: peerAId,
              kind: "video",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    );
    const secondMediaAnnouncement = getLastWsMessage(peerB.ws, "mediaAnnouncement");
    assert.ok(secondMediaAnnouncement);
    const secondAnnouncementItems = secondMediaAnnouncement.message as Array<{
      producerId: Guid;
      transportId: Guid;
    }>;
    assert.equal(secondAnnouncementItems[0]?.transportId, "egress-b-2");

    const writesBeforeProducerClose = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "producerClose",
      message: {
        originId: peerA.wsid,
        producerId: "producer-video-a-1" as Guid,
        mediaType: "video",
      },
    });
    const producerCloseWrites = h.netsocketWrites.slice(writesBeforeProducerClose);
    const producerCloseToIngress = producerCloseWrites.find(
      (entry) =>
        entry.destination === h.ingressServerId &&
        entry.signal.payload.type === "producerClose",
    );
    assert.ok(producerCloseToIngress);

    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "producerClosed",
        message: {
          originId: peerA.wsid,
          producerId: "producer-video-a-1" as Guid,
          mediaType: "video",
        },
      },
      h.ingressSocket,
    );
    const producerClosedForB = getLastWsMessage(peerB.ws, "producerClosed");
    assert.ok(producerClosedForB);
    const producerClosedMessage = producerClosedForB.message as {
      producerId: Guid;
    };
    assert.equal(producerClosedMessage.producerId, "producer-video-a-1");

    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "leaveRoom",
      message: { peerId: peerBId, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "leaveRoom",
      message: { peerId: peerAId, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "disconnectPeerWebsocket",
      message: { transport: peerA.wsid, code: 1000 },
    });
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "disconnectPeerWebsocket",
      message: { transport: peerB.wsid, code: 1000 },
    });

    const allErrors = [...parseWsMessages(peerA.ws), ...parseWsMessages(peerB.ws)]
      .filter((msg) => msg.type === "error")
      .map((msg) => String((msg.message as { error?: unknown }).error ?? ""));
    assert.deepEqual(allErrors, []);
    assert.ok(parseWsMessages(peerA.ws).some((msg) => msg.type === "roomDetached"));
    assert.ok(parseWsMessages(peerB.ws).some((msg) => msg.type === "roomDetached"));
    assert.deepEqual(peerA.ws.closeCodes, [1000]);
    assert.deepEqual(peerB.ws.closeCodes, [1000]);
  },
);

test(
  "full logic journey: media toggle on/off/on survives leave/rejoin churn",
  async () => {
    const h = createHarness();
    const [peerA, peerB] = h.peers;

    const peerAId = await identifyPeer(h.manager, peerA, h.region);
    const peerBId = await identifyPeer(h.manager, peerB, h.region);

    await joinPeer(h.manager, peerA, peerAId, h.room);
    await joinPeer(h.manager, peerB, peerBId, h.room);

    await setupPeerTransports({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      room: h.room,
      ingressServerId: h.ingressServerId,
      egressServerId: h.egressServerId,
      ingressSocket: h.ingressSocket,
      egressSocket: h.egressSocket,
      ingressTransportId: "ingress-a-toggle-1" as Guid,
      egressTransportId: "egress-a-toggle-1" as Guid,
    });
    await setupPeerTransports({
      manager: h.manager,
      peer: peerB,
      peerId: peerBId,
      room: h.room,
      ingressServerId: h.ingressServerId,
      egressServerId: h.egressServerId,
      ingressSocket: h.ingressSocket,
      egressSocket: h.egressSocket,
      ingressTransportId: "ingress-b-toggle-1" as Guid,
      egressTransportId: "egress-b-toggle-1" as Guid,
    });

    await produceMedia({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      ingressServerId: h.ingressServerId,
      ingressSocket: h.ingressSocket,
      ingressTransportId: "ingress-a-toggle-1" as Guid,
      kind: "audio",
      producerId: "producer-audio-toggle-1" as Guid,
      requestId: "req-audio-toggle-1",
    });
    await produceMedia({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      ingressServerId: h.ingressServerId,
      ingressSocket: h.ingressSocket,
      ingressTransportId: "ingress-a-toggle-1" as Guid,
      kind: "video",
      producerId: "producer-video-toggle-1" as Guid,
      requestId: "req-video-toggle-1",
    });

    const writesBeforeInitialRequests = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomAudio",
      message: { requestingPeer: peerBId },
    });
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const initialCreateConsumers = getCreateConsumerMessages(
      h.netsocketWrites.slice(writesBeforeInitialRequests),
    );
    assert.ok(
      initialCreateConsumers.some(
        (message) =>
          message.kind === "audio" &&
          createConsumerIncludesProducer(
            message,
            "producer-audio-toggle-1" as Guid,
          ),
      ),
    );
    assert.ok(
      initialCreateConsumers.some(
        (message) =>
          message.kind === "video" &&
          createConsumerIncludesProducer(
            message,
            "producer-video-toggle-1" as Guid,
          ),
      ),
    );

    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["egress-b-toggle-1" as Guid]: [
            {
              id: "consumer-b-audio-toggle-1" as Guid,
              producerId: "producer-audio-toggle-1" as Guid,
              producerPeerId: peerAId,
              kind: "audio",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    );
    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["egress-b-toggle-1" as Guid]: [
            {
              id: "consumer-b-video-toggle-1" as Guid,
              producerId: "producer-video-toggle-1" as Guid,
              producerPeerId: peerAId,
              kind: "video",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    );

    const firstAnnouncement = getLastWsMessage(peerB.ws, "mediaAnnouncement");
    assert.ok(firstAnnouncement);
    const firstAnnouncementItems = firstAnnouncement.message as Array<{
      producerId: Guid;
    }>;
    assert.ok(
      firstAnnouncementItems.some(
        (item) => item.producerId === ("producer-video-toggle-1" as Guid),
      ),
    );

    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "producerClose",
      message: {
        originId: peerA.wsid,
        producerId: "producer-video-toggle-1" as Guid,
        mediaType: "video",
      },
    });
    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "producerClosed",
        message: {
          originId: peerA.wsid,
          producerId: "producer-video-toggle-1" as Guid,
          mediaType: "video",
        },
      },
      h.ingressSocket,
    );

    const producerClosedForB = parseWsMessages(peerB.ws).filter(
      (msg) => msg.type === "producerClosed",
    );
    assert.ok(
      producerClosedForB.some(
        (msg) =>
          (msg.message as { producerId: Guid }).producerId ===
          ("producer-video-toggle-1" as Guid),
      ),
    );

    const writesBeforeVideoOffRequest = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const videoOffCreateConsumers = getCreateConsumerMessages(
      h.netsocketWrites.slice(writesBeforeVideoOffRequest),
    ).filter((message) => message.kind === "video");
    assert.equal(videoOffCreateConsumers.length, 0);

    await produceMedia({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      ingressServerId: h.ingressServerId,
      ingressSocket: h.ingressSocket,
      ingressTransportId: "ingress-a-toggle-1" as Guid,
      kind: "video",
      producerId: "producer-video-toggle-2" as Guid,
      requestId: "req-video-toggle-2",
    });

    const writesBeforeVideoOnRequest = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const videoOnCreateConsumers = getCreateConsumerMessages(
      h.netsocketWrites.slice(writesBeforeVideoOnRequest),
    ).filter((message) => message.kind === "video");
    assert.ok(
      videoOnCreateConsumers.some((message) =>
        createConsumerIncludesProducer(
          message,
          "producer-video-toggle-2" as Guid,
        ),
      ),
    );
    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["egress-b-toggle-1" as Guid]: [
            {
              id: "consumer-b-video-toggle-2" as Guid,
              producerId: "producer-video-toggle-2" as Guid,
              producerPeerId: peerAId,
              kind: "video",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    );
    const secondAnnouncement = getLastWsMessage(peerB.ws, "mediaAnnouncement");
    assert.ok(secondAnnouncement);
    const secondAnnouncementItems = secondAnnouncement.message as Array<{
      producerId: Guid;
    }>;
    assert.ok(
      secondAnnouncementItems.some(
        (item) => item.producerId === ("producer-video-toggle-2" as Guid),
      ),
    );

    const writesBeforeMuteOn = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "mutePeer",
      message: {
        requestingPeer: peerBId,
        targetPeer: peerAId,
        scope: "server",
        muted: true,
      },
    });
    const muteOnWrites = h.netsocketWrites.slice(writesBeforeMuteOn);
    assert.ok(
      muteOnWrites.some(
        (entry) =>
          entry.destination === h.ingressServerId &&
          entry.signal.payload.type === "setProducerPaused" &&
          entry.signal.payload.message.producerId ===
            ("producer-audio-toggle-1" as Guid) &&
          entry.signal.payload.message.paused === true,
      ),
    );

    const writesBeforeMuteOff = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "mutePeer",
      message: {
        requestingPeer: peerBId,
        targetPeer: peerAId,
        scope: "server",
        muted: false,
      },
    });
    const muteOffWrites = h.netsocketWrites.slice(writesBeforeMuteOff);
    assert.ok(
      muteOffWrites.some(
        (entry) =>
          entry.destination === h.ingressServerId &&
          entry.signal.payload.type === "setProducerPaused" &&
          entry.signal.payload.message.producerId ===
            ("producer-audio-toggle-1" as Guid) &&
          entry.signal.payload.message.paused === false,
      ),
    );

    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "leaveRoom",
      message: { peerId: peerBId, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "joinRoom",
      message: { peerId: peerBId, room: h.room },
    });
    await setupPeerTransports({
      manager: h.manager,
      peer: peerB,
      peerId: peerBId,
      room: h.room,
      ingressServerId: h.ingressServerId,
      egressServerId: h.egressServerId,
      ingressSocket: h.ingressSocket,
      egressSocket: h.egressSocket,
      ingressTransportId: "ingress-b-toggle-2" as Guid,
      egressTransportId: "egress-b-toggle-2" as Guid,
    });

    const writesBeforePostRejoinVideo = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const postRejoinVideoConsumers = getCreateConsumerMessages(
      h.netsocketWrites.slice(writesBeforePostRejoinVideo),
    ).filter((message) => message.kind === "video");
    assert.ok(
      postRejoinVideoConsumers.some(
        (message) =>
          message.consumerTransports.includes("egress-b-toggle-2" as Guid) &&
          createConsumerIncludesProducer(
            message,
            "producer-video-toggle-2" as Guid,
          ),
      ),
    );

    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "producerClose",
      message: {
        originId: peerA.wsid,
        producerId: "producer-video-toggle-2" as Guid,
        mediaType: "video",
      },
    });
    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "producerClosed",
        message: {
          originId: peerA.wsid,
          producerId: "producer-video-toggle-2" as Guid,
          mediaType: "video",
        },
      },
      h.ingressSocket,
    );
    await produceMedia({
      manager: h.manager,
      peer: peerA,
      peerId: peerAId,
      ingressServerId: h.ingressServerId,
      ingressSocket: h.ingressSocket,
      ingressTransportId: "ingress-a-toggle-1" as Guid,
      kind: "video",
      producerId: "producer-video-toggle-3" as Guid,
      requestId: "req-video-toggle-3",
    });

    const writesBeforeFinalVideoRequest = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerBId },
    });
    const finalVideoConsumers = getCreateConsumerMessages(
      h.netsocketWrites.slice(writesBeforeFinalVideoRequest),
    ).filter((message) => message.kind === "video");
    assert.ok(
      finalVideoConsumers.some(
        (message) =>
          message.consumerTransports.includes("egress-b-toggle-2" as Guid) &&
          createConsumerIncludesProducer(
            message,
            "producer-video-toggle-3" as Guid,
          ),
      ),
    );

    h.manager.incomingNetsocketCommand(
      h.egressServerId,
      {
        type: "createdConsumer",
        message: {
          ["egress-b-toggle-2" as Guid]: [
            {
              id: "consumer-b-video-toggle-3" as Guid,
              producerId: "producer-video-toggle-3" as Guid,
              producerPeerId: peerAId,
              kind: "video",
              rtpParameters: {},
              appData: {},
            },
          ],
        },
      },
      h.egressSocket,
    );

    const finalAnnouncement = getLastWsMessage(peerB.ws, "mediaAnnouncement");
    assert.ok(finalAnnouncement);
    const finalAnnouncementItems = finalAnnouncement.message as Array<{
      producerId: Guid;
      transportId: Guid;
    }>;
    assert.ok(
      finalAnnouncementItems.some(
        (item) =>
          item.producerId === ("producer-video-toggle-3" as Guid) &&
          item.transportId === ("egress-b-toggle-2" as Guid),
      ),
    );

    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "leaveRoom",
      message: { peerId: peerBId, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "leaveRoom",
      message: { peerId: peerAId, room: h.room },
    });
    await h.manager.incomingWebsocketSignal(peerA.wsid, {
      type: "disconnectPeerWebsocket",
      message: { transport: peerA.wsid, code: 1000 },
    });
    await h.manager.incomingWebsocketSignal(peerB.wsid, {
      type: "disconnectPeerWebsocket",
      message: { transport: peerB.wsid, code: 1000 },
    });

    const allErrors = [...parseWsMessages(peerA.ws), ...parseWsMessages(peerB.ws)]
      .filter((msg) => msg.type === "error")
      .map((msg) => String((msg.message as { error?: unknown }).error ?? ""));
    assert.deepEqual(allErrors, []);
    assert.deepEqual(peerA.ws.closeCodes, [1000]);
    assert.deepEqual(peerB.ws.closeCodes, [1000]);
  },
);
