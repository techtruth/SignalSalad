/**
 * Why this file exists:
 * - Three peers are the first topology where one producer fans out to multiple receivers.
 * - Two-peer tests cannot prove multi-target fanout planning/announcement behavior.
 * - This suite verifies that convergence and media fanout semantics remain correct
 *   when there are multiple downstream consumers.
 *
 * What this suite protects:
 * - 3-peer identity/join convergence and peerConnected event shape.
 * - consumer planning for one producer to two distinct egress transports.
 * - media announcement delivery to both receiving peers.
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
  const wsidA = "ws-peer-a-3" as Guid;
  const wsidB = "ws-peer-b-3" as Guid;
  const wsidC = "ws-peer-c-3" as Guid;
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";
  const room = "demo";

  const wsA = createFakeWs();
  const wsB = createFakeWs();
  const wsC = createFakeWs();
  const wsClients = new Map<Guid, unknown>([
    [wsidA, wsA as unknown],
    [wsidB, wsB as unknown],
    [wsidC, wsC as unknown],
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

  return { manager, wsidA, wsidB, wsidC, wsA, wsB, wsC, room, region, egressServerId, egressSocket };
};

test("three-peer happy path: identity/join convergence with expected peer-connected events", async () => {
  const h = createHarness();
  const wsids = [h.wsidA, h.wsidB, h.wsidC];
  const wss = [h.wsA, h.wsB, h.wsC];

  for (const wsid of wsids) {
    await h.manager.incomingWebsocketSignal(wsid, {
      type: "requestIdentity",
      message: { region: h.region },
    });
  }

  const peerIds = wss.map((ws) => {
    const identity = parseWsMessages(ws).find((msg) => msg.type === "identity");
    assert.ok(identity);
    return identity.message.peerId as Guid;
  });

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "joinRoom",
    message: { peerId: peerIds[0], room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "joinRoom",
    message: { peerId: peerIds[1], room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsidC, {
    type: "joinRoom",
    message: { peerId: peerIds[2], room: h.room },
  });

  const allEvents = wss.flatMap((ws) => parseWsMessages(ws));
  const errors = allEvents.filter((msg) => msg.type === "error");
  assert.equal(errors.length, 0);
  assert.equal(allEvents.filter((msg) => msg.type === "roomAttached").length, 3);
  assert.equal(allEvents.filter((msg) => msg.type === "peerConnected").length, 3);
});

test("three-peer media fanout: one producer plans/announces consumers to two peers", async () => {
  const h = createHarness();

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "requestIdentity",
    message: { region: h.region },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "requestIdentity",
    message: { region: h.region },
  });
  await h.manager.incomingWebsocketSignal(h.wsidC, {
    type: "requestIdentity",
    message: { region: h.region },
  });

  const peerIdA = parseWsMessages(h.wsA).find((msg) => msg.type === "identity")!.message.peerId as Guid;
  const peerIdB = parseWsMessages(h.wsB).find((msg) => msg.type === "identity")!.message.peerId as Guid;
  const peerIdC = parseWsMessages(h.wsC).find((msg) => msg.type === "identity")!.message.peerId as Guid;

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "joinRoom",
    message: { peerId: peerIdA, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "joinRoom",
    message: { peerId: peerIdB, room: h.room },
  });
  await h.manager.incomingWebsocketSignal(h.wsidC, {
    type: "joinRoom",
    message: { peerId: peerIdC, room: h.room },
  });

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdWebRTCEgressTransport",
      message: {
        originId: h.wsidA,
        transportId: "egress-a-3" as Guid,
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
        transportId: "egress-b-3" as Guid,
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
        originId: h.wsidC,
        transportId: "egress-c-3" as Guid,
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
      },
    },
    h.egressSocket,
  );

  for (const [peerId, wsid] of [
    [peerIdA, h.wsidA],
    [peerIdB, h.wsidB],
    [peerIdC, h.wsidC],
  ] as const) {
    const peer = h.manager.peers.get(peerId)!;
    h.manager.peers.set(peerId, {
      ...peer,
      mediaState: "ready",
      signalTransport: wsid,
      deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
    } as typeof peer);
  }

  const planned = getRuntime(
    h.manager,
  ).services.peerMediaSession.createConsumerPayload(
    h.wsidA,
    "producer-video-a-3",
    "video",
    h.egressServerId,
  );
  assert.equal(planned.length, 2);
  const plannedTransports = planned.flatMap((entry) => entry.consumerTransports).sort();
  assert.deepEqual(plannedTransports, ["egress-b-3", "egress-c-3"]);

  h.manager.incomingNetsocketCommand(
    h.egressServerId,
    {
      type: "createdConsumer",
      message: {
        ["egress-b-3" as Guid]: [
          {
            id: "consumer-b-video-a-3" as Guid,
            producerId: "producer-video-a-3" as Guid,
            producerPeerId: peerIdA,
            kind: "video",
            rtpParameters: {},
            appData: {},
          },
        ],
        ["egress-c-3" as Guid]: [
          {
            id: "consumer-c-video-a-3" as Guid,
            producerId: "producer-video-a-3" as Guid,
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

  assert.ok(parseWsMessages(h.wsB).some((msg) => msg.type === "mediaAnnouncement"));
  assert.ok(parseWsMessages(h.wsC).some((msg) => msg.type === "mediaAnnouncement"));
});
