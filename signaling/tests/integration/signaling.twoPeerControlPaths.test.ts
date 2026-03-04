/**
 * Why this file exists:
 * - Some high-risk behaviors are coordinator/control-path transitions rather than user flows.
 * - These paths can regress without obvious failures if not directly asserted.
 * - This suite focuses on relay coordination and cleanup semantics that are central to correctness.
 *
 * What this suite protects:
 * - relay command sequence: initialize -> connect -> finalize -> consumer creation.
 * - producer-close propagation to other peer(s).
 * - abrupt disconnect cleanup and expected peerDisconnected signaling.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import { RoomRelay } from "../../lib/core/room/roomRelay.js";
import { getSignalingRuntime } from "./runtimeAccess.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

type SignalingRuntimeView = {
  stores: {
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
  services: {
    peerMediaSession: {
      applyProducerClosed: (producerId: Guid, mediaType: string) => void;
    };
    peerLifecycle: { deletePeer: (peerId: Guid) => void };
  };
};

const getRuntime = (manager: Signaling) =>
  getSignalingRuntime<SignalingRuntimeView>(manager);

const createFakeWs = (): FakeWs => ({
  sent: [],
  send(payload: string) {
    this.sent.push(payload);
  },
  close(_code: number) {},
});

const parseWsMessages = (socket: FakeWs) =>
  socket.sent.map(
    (entry) =>
      JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

const createHarness = () => {
  const wsidA = "ws-peer-a-control" as Guid;
  const wsidB = "ws-peer-b-control" as Guid;
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

  const ingressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const egressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
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
    {
      type: "registerMediaServer",
      message: { registrationId: ingressServerId, mode: "ingress", region },
    },
    ingressSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    {
      type: "registerMediaServer",
      message: { registrationId: egressServerId, mode: "egress", region },
    },
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
    ingressSocket,
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
  const peerIdA = parseWsMessages(h.wsA).find((m) => m.type === "identity")!
    .message.peerId as Guid;
  const peerIdB = parseWsMessages(h.wsB).find((m) => m.type === "identity")!
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

test("control-path: relay coordinator sequence produces connect/finalize/create-consumer", () => {
  const calls: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  const relay = new RoomRelay({
    pipeRegistry: {
      findPipe: () => undefined,
      addPipe: () => {
        calls.push({ kind: "upsertPipeTransport", payload: {} });
      },
    },
    serverAddressRegistry: {
      resolveRegisteredServerIp: (_serverId, mode) =>
        mode === "ingress" ? "10.0.0.1" : "10.0.0.2",
    },
    signalingMessenger: {
      sendNetsocketMessage: (_destinationNode, _channel, type, message) => {
        if (type === "connectNetworkRelay") {
          calls.push({
            kind: "connectNetworkRelay",
            payload: message as Record<string, unknown>,
          });
          return;
        }
        if (type === "finalizeNetworkRelay") {
          calls.push({
            kind: "finalizeNetworkRelay",
            payload: message as Record<string, unknown>,
          });
          return;
        }
        if (type === "createConsumer") {
          calls.push({
            kind: "createConsumer",
            payload: message as Record<string, unknown>,
          });
        }
      },
    },
    consumerPlanner: {
      createConsumerPayload: () => [
        {
          kind: "video",
          consumerTransports: ["egress-transport-b" as Guid],
          producerIds: [{ ["peer-a" as Guid]: ["producer-1" as Guid] }],
          room: "demo",
          rtpCaps: { codecs: [], headerExtensions: [] },
        },
      ],
    },
  });
  relay.initializedNetworkRelay("ingress-1" as Guid, {
    originId: "ws-a" as Guid,
    producerId: "producer-1" as Guid,
    routerNetwork: "demo",
    consumerOptions: {},
    createNetworkPipeTransport: true,
    ingressIp: "127.0.0.1",
    ingressPort: 10020,
    protocol: "udp",
    appData: {},
    egressServer: "egress-1" as Guid,
  });
  relay.connectedNetworkRelay("egress-1" as Guid, {
    originId: "ws-a" as Guid,
    routerNetwork: "demo",
    producerId: "producer-1" as Guid,
    connectedTransport: true,
    egressIp: "127.0.0.1",
    egressPort: 10021,
    protocol: "udp",
    appData: {},
    ingressServer: "ingress-1" as Guid,
  });
  relay.finalizedNetworkRelay("ingress-1" as Guid, {
    originId: "ws-a" as Guid,
    producerId: "producer-1" as Guid,
    routerNetwork: "demo",
    kind: "video",
    ingressIp: "10.0.0.1",
    ingressPort: 10020,
    egressIp: "10.0.0.2",
    egressPort: 10021,
    egressServer: "egress-1" as Guid,
  });

  const kinds = calls.map((c) => c.kind);
  assert.ok(kinds.includes("connectNetworkRelay"));
  assert.ok(kinds.includes("finalizeNetworkRelay"));
  assert.ok(kinds.includes("upsertPipeTransport"));
  assert.ok(kinds.includes("createConsumer"));
});

test("control-path: applyProducerClosed notifies the other peer", async () => {
  const h = createHarness();
  const { peerIdA } = await setupJoinedPeers(h);

  getRuntime(h.manager).stores.producers.recordProducer(
    "producer-a-video" as Guid,
    peerIdA,
    h.room,
    "video",
    h.ingressServerId,
  );

  getRuntime(h.manager).services.peerMediaSession.applyProducerClosed(
    "producer-a-video" as Guid,
    "video",
  );

  const notify = parseWsMessages(h.wsB).find(
    (msg) =>
      msg.type === "producerClosed" &&
      msg.message.producerId === ("producer-a-video" as Guid) &&
      msg.message.originId === peerIdA,
  );
  assert.ok(notify);
});

test("control-path: duplicate producerClosed callback is idempotent", async () => {
  const h = createHarness();
  const { peerIdA } = await setupJoinedPeers(h);

  getRuntime(h.manager).stores.producers.recordProducer(
    "producer-a-audio" as Guid,
    peerIdA,
    h.room,
    "audio",
    h.ingressServerId,
  );

  h.manager.incomingNetsocketCommand(
    h.ingressServerId,
    {
      type: "producerClosed",
      message: {
        originId: h.wsidA,
        producerId: "producer-a-audio" as Guid,
        mediaType: "audio",
      },
    },
    h.ingressSocket,
  );

  assert.doesNotThrow(() => {
    h.manager.incomingNetsocketCommand(
      h.ingressServerId,
      {
        type: "producerClosed",
        message: {
          originId: h.wsidA,
          producerId: "producer-a-audio" as Guid,
          mediaType: "audio",
        },
      },
      h.ingressSocket,
    );
  });
});

test("control-path: deletePeer on abrupt disconnect removes peer and emits peerDisconnected", async () => {
  const h = createHarness();
  const { peerIdA } = await setupJoinedPeers(h);

  getRuntime(h.manager).services.peerLifecycle.deletePeer(peerIdA);

  const disconnected = parseWsMessages(h.wsB).find(
    (msg) => msg.type === "peerDisconnected" && msg.message.peerId === peerIdA,
  );
  assert.ok(disconnected);
  assert.equal(h.manager.peers.get(peerIdA), undefined);
});
