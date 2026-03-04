/**
 * Why this file exists:
 * - Scaling behavior must stay correct across topology flavors:
 *   local/single-pool, local/multi-pool, 2-region, and 3-region deployments.
 * - Regressions in regional server selection or room route accumulation can break
 *   media reachability under growth even when basic peer tests still pass.
 *
 * What this suite protects:
 * - least-loaded ingress/egress server selection per region in each flavor.
 * - room routing egress set converges to the union of participating peer egress servers.
 * - consumer planning supports both same-egress (best case) and cross-egress paths.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid, Peer } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import { getSignalingRuntime } from "./runtimeAccess.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  closeCodes: number[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

type Scenario = {
  name: string;
  room: string;
  ingressRegions: Record<string, Guid[]>;
  egressRegions: Record<string, Guid[]>;
  ingressLoad: Record<string, Record<Guid, number>>;
  egressLoad: Record<string, Record<Guid, number>>;
  peerRegions: string[];
  expectCrossEgress: boolean;
};

type SignalingRuntimeView = {
  stores: {
    roomRouting: {
      getRoutingTable: () => Map<string, { ingress: Guid[]; egress: Guid[] }>;
    };
  };
  services: {
    peerMediaSession: {
      createConsumerPayload: (
        originId: Guid,
        producerId: string,
        kind: "video" | "audio",
        egressId: string,
      ) => Array<{ consumerTransports: Guid[] }>;
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
    (entry) =>
      JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

const firstMessageByType = (socket: FakeWs, type: string) =>
  parseWsMessages(socket).find((msg) => msg.type === type);

const createPeerRegions = (counts: Record<string, number>) => {
  const regions = new Array<string>();
  for (const [region, count] of Object.entries(counts)) {
    for (let idx = 0; idx < count; idx++) {
      regions.push(region);
    }
  }
  return regions;
};

const getLeastLoadedServer = (
  region: string,
  regionServers: Record<string, Guid[]>,
  regionLoad: Record<string, Record<Guid, number>>,
) => {
  const servers = regionServers[region];
  assert.ok(servers?.length, `missing servers for region ${region}`);
  const load = regionLoad[region];
  assert.ok(load, `missing load index for region ${region}`);
  const entries = servers.map((serverId) => ({
    serverId,
    load: load[serverId],
  }));
  assert.ok(
    entries.every((entry) => typeof entry.load === "number"),
    `missing load value for one or more servers in region ${region}`,
  );
  const min = Math.min(...entries.map((entry) => entry.load));
  const candidates = entries
    .filter((entry) => entry.load === min)
    .map((entry) => entry.serverId);
  assert.equal(
    candidates.length,
    1,
    `scenario requires unique least-loaded server for ${region}`,
  );
  return candidates[0];
};

const createHarness = (scenario: Scenario) => {
  const peers = scenario.peerRegions.map((region, idx) => ({
    wsid: `ws-scale-${scenario.name}-${idx + 1}` as Guid,
    ws: createFakeWs(),
    region,
  }));

  const wsClients = new Map<Guid, unknown>(
    peers.map((peer) => [peer.wsid, peer.ws as unknown]),
  );

  const ingressSockets = new Map<Guid, NetSocket>();
  const egressSockets = new Map<Guid, NetSocket>();
  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const encoder = { write(_buffer: Buffer) { return true; } } as unknown as Transform;

  for (const serverIds of Object.values(scenario.ingressRegions)) {
    for (const serverId of serverIds) {
      const socket = { remoteAddress: "127.0.0.1" } as NetSocket;
      ingressSockets.set(serverId, socket);
      nsEncoders.set(socket, encoder);
    }
  }
  for (const serverIds of Object.values(scenario.egressRegions)) {
    for (const serverId of serverIds) {
      const socket = { remoteAddress: "127.0.0.1" } as NetSocket;
      egressSockets.set(serverId, socket);
      nsEncoders.set(socket, encoder);
    }
  }

  const servers = createTestServers({
    wsClients,
    ingress: ingressSockets,
    egress: egressSockets,
    nsEncoders,
  });

  const manager = new Signaling({
    ...servers,
    ingressRegions: scenario.ingressRegions,
    egressRegions: scenario.egressRegions,
    ingressLoad: scenario.ingressLoad,
    egressLoad: scenario.egressLoad,
  });

  for (const [region, serverIds] of Object.entries(scenario.ingressRegions)) {
    for (const serverId of serverIds) {
      const socket = ingressSockets.get(serverId);
      assert.ok(socket, `missing ingress socket ${serverId}`);
      manager.incomingNetsocketCommand(
        serverId,
        {
          type: "registerMediaServer",
          message: { registrationId: serverId, mode: "ingress", region },
        },
        socket,
      );
    }
  }
  for (const [region, serverIds] of Object.entries(scenario.egressRegions)) {
    for (const serverId of serverIds) {
      const socket = egressSockets.get(serverId);
      assert.ok(socket, `missing egress socket ${serverId}`);
      manager.incomingNetsocketCommand(
        serverId,
        {
          type: "registerMediaServer",
          message: { registrationId: serverId, mode: "egress", region },
        },
        socket,
      );
    }
  }

  return { manager, peers };
};

const getRoomRouting = (manager: Signaling, room: string) => {
  return getRuntime(manager).stores.roomRouting.getRoutingTable().get(room);
};

const setPeersReadyForEgressRoutes = (
  manager: Signaling,
  peerIds: Guid[],
  roomEgressServers: Guid[],
) => {
  for (const peerId of peerIds) {
    const peer = manager.peers.get(peerId);
    assert.ok(peer, `missing peer ${peerId} while setting ready state`);
    const transportEgress = Object.fromEntries(
      roomEgressServers.map((egressId) => [
        egressId,
        `${peerId}:${egressId}` as Guid,
      ]),
    );
    manager.peers.set(peerId, {
      ...peer,
      mediaState: "ready",
      transportEgress,
      deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
    } as Peer);
  }
};

const assertConsumerPlanningCases = (params: {
  manager: Signaling;
  producerOrigin: Guid;
  producerPeerId: Guid;
  producerEgress: Guid;
  roomEgressServers: Guid[];
  peerCount: number;
  expectCrossEgress: boolean;
}) => {
  const {
    manager,
    producerOrigin,
    producerPeerId,
    producerEgress,
    roomEgressServers,
    peerCount,
    expectCrossEgress,
  } = params;

  const samePath = getRuntime(manager).services.peerMediaSession.createConsumerPayload(
    producerOrigin,
    "producer-scale-test-video",
    "video",
    producerEgress,
  );
  assert.equal(samePath.length, peerCount - 1);
  assert.ok(
    samePath.every((entry) =>
      entry.consumerTransports.every((id) =>
        String(id).endsWith(`:${producerEgress}`),
      ),
    ),
  );

  if (!expectCrossEgress) {
    return;
  }

  const crossEgress = roomEgressServers.find((id) => id !== producerEgress);
  assert.ok(crossEgress, "expected at least one cross-egress route");
  const crossPath = getRuntime(
    manager,
  ).services.peerMediaSession.createConsumerPayload(
    producerOrigin,
    "producer-scale-test-video",
    "video",
    crossEgress,
  );
  assert.equal(crossPath.length, peerCount - 1);
  assert.ok(
    crossPath.every((entry) =>
      entry.consumerTransports.every((id) =>
        String(id).endsWith(`:${crossEgress}`),
      ),
    ),
  );

  const producer = manager.peers.get(producerPeerId);
  assert.ok(producer, `missing producer peer ${producerPeerId}`);
  assert.notEqual(
    crossEgress,
    producer?.egress,
    "cross-egress case must target a different egress than producer egress",
  );
};

const scenarios: Scenario[] = [
  {
    name: "local-single",
    room: "room-local-single",
    ingressRegions: {
      local: ["ingress-local-1" as Guid],
    },
    egressRegions: {
      local: ["egress-local-1" as Guid],
    },
    ingressLoad: {
      local: { ["ingress-local-1" as Guid]: 1 },
    },
    egressLoad: {
      local: { ["egress-local-1" as Guid]: 1 },
    },
    peerRegions: createPeerRegions({ local: 4 }),
    expectCrossEgress: false,
  },
  {
    name: "local-multi",
    room: "room-local-multi",
    ingressRegions: {
      local: ["ingress-local-1" as Guid, "ingress-local-2" as Guid],
    },
    egressRegions: {
      local: ["egress-local-1" as Guid, "egress-local-2" as Guid],
    },
    ingressLoad: {
      local: {
        ["ingress-local-1" as Guid]: 50,
        ["ingress-local-2" as Guid]: 10,
      },
    },
    egressLoad: {
      local: {
        ["egress-local-1" as Guid]: 90,
        ["egress-local-2" as Guid]: 5,
      },
    },
    peerRegions: createPeerRegions({ local: 4 }),
    expectCrossEgress: false,
  },
  {
    name: "two-region-single",
    room: "room-two-single",
    ingressRegions: {
      east: ["ingress-east-1" as Guid],
      west: ["ingress-west-1" as Guid],
    },
    egressRegions: {
      east: ["egress-east-1" as Guid],
      west: ["egress-west-1" as Guid],
    },
    ingressLoad: {
      east: { ["ingress-east-1" as Guid]: 1 },
      west: { ["ingress-west-1" as Guid]: 1 },
    },
    egressLoad: {
      east: { ["egress-east-1" as Guid]: 1 },
      west: { ["egress-west-1" as Guid]: 1 },
    },
    peerRegions: createPeerRegions({ east: 2, west: 2 }),
    expectCrossEgress: true,
  },
  {
    name: "two-region-multi",
    room: "room-two-multi",
    ingressRegions: {
      east: ["ingress-east-1" as Guid, "ingress-east-2" as Guid],
      west: ["ingress-west-1" as Guid, "ingress-west-2" as Guid],
    },
    egressRegions: {
      east: ["egress-east-1" as Guid, "egress-east-2" as Guid],
      west: ["egress-west-1" as Guid, "egress-west-2" as Guid],
    },
    ingressLoad: {
      east: {
        ["ingress-east-1" as Guid]: 30,
        ["ingress-east-2" as Guid]: 8,
      },
      west: {
        ["ingress-west-1" as Guid]: 5,
        ["ingress-west-2" as Guid]: 22,
      },
    },
    egressLoad: {
      east: {
        ["egress-east-1" as Guid]: 19,
        ["egress-east-2" as Guid]: 2,
      },
      west: {
        ["egress-west-1" as Guid]: 3,
        ["egress-west-2" as Guid]: 40,
      },
    },
    peerRegions: createPeerRegions({ east: 2, west: 2 }),
    expectCrossEgress: true,
  },
  {
    name: "three-region-single",
    room: "room-three-single",
    ingressRegions: {
      north: ["ingress-north-1" as Guid],
      east: ["ingress-east-1" as Guid],
      west: ["ingress-west-1" as Guid],
    },
    egressRegions: {
      north: ["egress-north-1" as Guid],
      east: ["egress-east-1" as Guid],
      west: ["egress-west-1" as Guid],
    },
    ingressLoad: {
      north: { ["ingress-north-1" as Guid]: 1 },
      east: { ["ingress-east-1" as Guid]: 1 },
      west: { ["ingress-west-1" as Guid]: 1 },
    },
    egressLoad: {
      north: { ["egress-north-1" as Guid]: 1 },
      east: { ["egress-east-1" as Guid]: 1 },
      west: { ["egress-west-1" as Guid]: 1 },
    },
    peerRegions: createPeerRegions({ north: 2, east: 2, west: 2 }),
    expectCrossEgress: true,
  },
  {
    name: "three-region-multi",
    room: "room-three-multi",
    ingressRegions: {
      north: ["ingress-north-1" as Guid, "ingress-north-2" as Guid],
      east: ["ingress-east-1" as Guid, "ingress-east-2" as Guid],
      west: ["ingress-west-1" as Guid, "ingress-west-2" as Guid],
    },
    egressRegions: {
      north: ["egress-north-1" as Guid, "egress-north-2" as Guid],
      east: ["egress-east-1" as Guid, "egress-east-2" as Guid],
      west: ["egress-west-1" as Guid, "egress-west-2" as Guid],
    },
    ingressLoad: {
      north: {
        ["ingress-north-1" as Guid]: 15,
        ["ingress-north-2" as Guid]: 2,
      },
      east: {
        ["ingress-east-1" as Guid]: 4,
        ["ingress-east-2" as Guid]: 12,
      },
      west: {
        ["ingress-west-1" as Guid]: 20,
        ["ingress-west-2" as Guid]: 3,
      },
    },
    egressLoad: {
      north: {
        ["egress-north-1" as Guid]: 17,
        ["egress-north-2" as Guid]: 6,
      },
      east: {
        ["egress-east-1" as Guid]: 1,
        ["egress-east-2" as Guid]: 13,
      },
      west: {
        ["egress-west-1" as Guid]: 11,
        ["egress-west-2" as Guid]: 5,
      },
    },
    peerRegions: createPeerRegions({ north: 2, east: 2, west: 2 }),
    expectCrossEgress: true,
  },
];

for (const scenario of scenarios) {
  test(
    `scaling distribution: ${scenario.name} assigns peers to least-loaded regional ingress/egress and supports same/cross egress planning`,
    async () => {
      const h = createHarness(scenario);
      const peerIdByWsid = new Map<Guid, Guid>();

      for (const peer of h.peers) {
        await h.manager.incomingWebsocketSignal(peer.wsid, {
          type: "requestIdentity",
          message: { region: peer.region },
        });
        const identity = firstMessageByType(peer.ws, "identity");
        assert.ok(identity, `missing identity for ${peer.wsid}`);
        peerIdByWsid.set(peer.wsid, identity.message.peerId as Guid);
      }

      for (const peer of h.peers) {
        const peerId = peerIdByWsid.get(peer.wsid);
        await h.manager.incomingWebsocketSignal(peer.wsid, {
          type: "joinRoom",
          message: { peerId, room: scenario.room },
        });
      }

      const allEvents = h.peers.flatMap((peer) => parseWsMessages(peer.ws));
      const errors = allEvents.filter((msg) => msg.type === "error");
      assert.equal(
        errors.length,
        0,
        `unexpected errors in ${scenario.name}: ${JSON.stringify(errors.slice(0, 3))}`,
      );

      const expectedEgressByPeer = new Map<Guid, Guid>();
      for (const peer of h.peers) {
        const peerId = peerIdByWsid.get(peer.wsid)!;
        const expectedIngress = getLeastLoadedServer(
          peer.region,
          scenario.ingressRegions,
          scenario.ingressLoad,
        );
        const expectedEgress = getLeastLoadedServer(
          peer.region,
          scenario.egressRegions,
          scenario.egressLoad,
        );
        const peerData = h.manager.peers.get(peerId);
        assert.ok(peerData, `missing peer ${peerId} after join`);
        assert.equal(peerData?.ingress, expectedIngress);
        assert.equal(peerData?.egress, expectedEgress);
        expectedEgressByPeer.set(peerId, expectedEgress);
      }

      const roomRouting = getRoomRouting(h.manager, scenario.room);
      assert.ok(roomRouting, `missing room routing for ${scenario.room}`);
      const expectedEgressSet = new Set<Guid>(expectedEgressByPeer.values());
      assert.deepEqual(
        new Set<Guid>(roomRouting?.egress ?? []),
        expectedEgressSet,
      );

      const peerIds = Array.from(peerIdByWsid.values());
      const producerPeerId = peerIds[0];
      assert.ok(producerPeerId);
      const producerPeer = h.manager.peers.get(producerPeerId)!;
      const producerOrigin = producerPeer.transportSignal;
      const producerEgress = producerPeer.egress;
      const roomEgressServers = Array.from(expectedEgressSet.values());

      setPeersReadyForEgressRoutes(h.manager, peerIds, roomEgressServers);
      assertConsumerPlanningCases({
        manager: h.manager,
        producerOrigin,
        producerPeerId,
        producerEgress,
        roomEgressServers,
        peerCount: peerIds.length,
        expectCrossEgress: scenario.expectCrossEgress,
      });
    },
  );
}
