/**
 * Why this file exists:
 * - Existing suites mostly validate single-region behavior.
 * - Region-routing correctness is critical for selecting ingress/egress pools.
 * - This suite verifies multi-region selection, cross-region room behavior,
 *   and failure paths when regional capacity is incomplete.
 *
 * What this suite protects:
 * - case-insensitive region names still resolve to configured region pools.
 * - peers in different regions can share a room while keeping region-local egress assignments.
 * - invalid region requests are rejected at identity time.
 * - join fails when a region has only ingress or only egress capacity.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid, Peer } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

type RegionServerConfig = {
  ingress: Record<string, Guid[]>;
  egress: Record<string, Guid[]>;
};

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

const firstMessageByType = (socket: FakeWs, type: string) =>
  parseWsMessages(socket).find((msg) => msg.type === type);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const createHarness = (regionConfig: RegionServerConfig) => {
  const wsidA = "ws-peer-a-multi-region" as Guid;
  const wsidB = "ws-peer-b-multi-region" as Guid;
  const wsA = createFakeWs();
  const wsB = createFakeWs();

  const wsClients = new Map<Guid, unknown>([
    [wsidA, wsA as unknown],
    [wsidB, wsB as unknown],
  ]);

  const ingress = new Map<Guid, NetSocket>();
  const egress = new Map<Guid, NetSocket>();
  const nsEncoders = new WeakMap<NetSocket, Transform>();

  const encoder = { write(_buffer: Buffer) { return true; } } as unknown as Transform;

  const registerMode = (
    mode: "ingress" | "egress",
    regionMap: Record<string, Guid[]>,
  ) => {
    for (const [region, serverIds] of Object.entries(regionMap)) {
      for (const serverId of serverIds) {
        const socket = { remoteAddress: "127.0.0.1" } as NetSocket;
        nsEncoders.set(socket, encoder);
        if (mode === "ingress") {
          ingress.set(serverId, socket);
        } else {
          egress.set(serverId, socket);
        }
      }
    }
  };

  registerMode("ingress", regionConfig.ingress);
  registerMode("egress", regionConfig.egress);

  const ingressRegions = Object.fromEntries(
    Object.entries(regionConfig.ingress).map(([region, ids]) => [region, [...ids]]),
  );
  const egressRegions = Object.fromEntries(
    Object.entries(regionConfig.egress).map(([region, ids]) => [region, [...ids]]),
  );

  const ingressLoad = Object.fromEntries(
    Object.entries(regionConfig.ingress).map(([region, ids]) => [
      region,
      Object.fromEntries(ids.map((id, idx) => [id, idx + 1])),
    ]),
  );
  const egressLoad = Object.fromEntries(
    Object.entries(regionConfig.egress).map(([region, ids]) => [
      region,
      Object.fromEntries(ids.map((id, idx) => [id, idx + 1])),
    ]),
  );

  const servers = createTestServers({
    wsClients,
    ingress,
    egress,
    nsEncoders,
  });

  const manager = new Signaling({
    ...servers,
    ingressRegions,
    egressRegions,
    ingressLoad,
    egressLoad,
  });

  for (const [region, serverIds] of Object.entries(regionConfig.ingress)) {
    for (const serverId of serverIds) {
      const socket = ingress.get(serverId);
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

  for (const [region, serverIds] of Object.entries(regionConfig.egress)) {
    for (const serverId of serverIds) {
      const socket = egress.get(serverId);
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

  return { manager, wsidA, wsidB, wsA, wsB };
};

const requirePeer = (manager: Signaling, peerId: Guid): Peer => {
  const peer = manager.peers.get(peerId);
  assert.ok(peer, `missing peer ${peerId}`);
  return peer;
};

const createScaleHarness = (peerCount: number, regionConfig: RegionServerConfig) => {
  const peers = Array.from({ length: peerCount }, (_, idx) => {
    const wsid = `ws-peer-${idx + 1}-multi-region` as Guid;
    return { wsid, ws: createFakeWs() };
  });

  const wsClients = new Map<Guid, unknown>(
    peers.map((peer) => [peer.wsid, peer.ws as unknown]),
  );

  const ingress = new Map<Guid, NetSocket>();
  const egress = new Map<Guid, NetSocket>();
  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const ingressSockets = new Map<Guid, NetSocket>();
  const egressSockets = new Map<Guid, NetSocket>();
  const netsocketWrites: Array<{
    node: string;
    payload: { type: string; message: Record<string, unknown> };
  }> = [];

  const registerMode = (
    mode: "ingress" | "egress",
    regionMap: Record<string, Guid[]>,
  ) => {
    for (const serverIds of Object.values(regionMap)) {
      for (const serverId of serverIds) {
        const socket = { remoteAddress: "127.0.0.1" } as NetSocket;
        const encoder = {
          write(buffer: Buffer) {
            const parsed = JSON.parse(buffer.toString()) as {
              node?: string;
              payload?: { type: string; message: Record<string, unknown> };
              type?: string;
              message?: Record<string, unknown>;
            };
            netsocketWrites.push({
              node: parsed.node ?? serverId,
              payload:
                parsed.payload ??
                ({
                  type: String(parsed.type ?? ""),
                  message: (parsed.message ?? {}) as Record<string, unknown>,
                }),
            });
            return true;
          },
        } as unknown as Transform;
        nsEncoders.set(socket, encoder);
        if (mode === "ingress") {
          ingress.set(serverId, socket);
          ingressSockets.set(serverId, socket);
        } else {
          egress.set(serverId, socket);
          egressSockets.set(serverId, socket);
        }
      }
    }
  };

  registerMode("ingress", regionConfig.ingress);
  registerMode("egress", regionConfig.egress);

  const servers = createTestServers({
    wsClients,
    ingress,
    egress,
    nsEncoders,
  });

  const manager = new Signaling({
    ...servers,
    ingressRegions: Object.fromEntries(
      Object.entries(regionConfig.ingress).map(([region, ids]) => [region, [...ids]]),
    ),
    egressRegions: Object.fromEntries(
      Object.entries(regionConfig.egress).map(([region, ids]) => [region, [...ids]]),
    ),
    ingressLoad: Object.fromEntries(
      Object.entries(regionConfig.ingress).map(([region, ids]) => [
        region,
        Object.fromEntries(ids.map((id, idx) => [id, idx + 1])),
      ]),
    ),
    egressLoad: Object.fromEntries(
      Object.entries(regionConfig.egress).map(([region, ids]) => [
        region,
        Object.fromEntries(ids.map((id, idx) => [id, idx + 1])),
      ]),
    ),
  });

  for (const [region, serverIds] of Object.entries(regionConfig.ingress)) {
    for (const serverId of serverIds) {
      const socket = ingress.get(serverId);
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
  for (const [region, serverIds] of Object.entries(regionConfig.egress)) {
    for (const serverId of serverIds) {
      const socket = egress.get(serverId);
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

  return { manager, peers, ingressSockets, egressSockets, netsocketWrites };
};

test("multi-region: requestIdentity region lookup is case-insensitive and joins region-local pools", async () => {
  const h = createHarness({
    ingress: {
      east: ["ingress-east-1" as Guid],
      west: ["ingress-west-1" as Guid],
      north: ["ingress-north-1" as Guid],
      south: ["ingress-south-1" as Guid],
    },
    egress: {
      north: ["egress-north-1" as Guid],
      south: ["egress-south-1" as Guid, "egress-south-2" as Guid],
      east: [
        "egress-east-1" as Guid,
        "egress-east-2" as Guid,
        "egress-east-3" as Guid,
      ],
      west: [
        "egress-west-1" as Guid,
        "egress-west-2" as Guid,
        "egress-west-3" as Guid,
        "egress-west-4" as Guid,
      ],
    },
  });

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "requestIdentity",
    message: { region: "EAST" },
  });

  const identity = firstMessageByType(h.wsA, "identity");
  assert.ok(identity);
  const peerId = identity.message.peerId as Guid;

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "joinRoom",
    message: { peerId, room: "demo-multi" },
  });

  const roomAttached = firstMessageByType(h.wsA, "roomAttached");
  assert.ok(roomAttached);
  assert.deepEqual(roomAttached.message.egressServers, ["egress-east-1"]);

  const peer = requirePeer(h.manager, peerId);
  assert.equal(peer.region, "EAST");
  assert.equal(peer.ingress, "ingress-east-1");
  assert.equal(peer.egress, "egress-east-1");
});

test("multi-region: two peers in different regions share room and keep region-specific ingress/egress", async () => {
  const h = createHarness({
    ingress: {
      east: ["ingress-east-1" as Guid],
      west: ["ingress-west-1" as Guid],
      north: ["ingress-north-1" as Guid],
      south: ["ingress-south-1" as Guid],
    },
    egress: {
      north: ["egress-north-1" as Guid],
      south: ["egress-south-1" as Guid, "egress-south-2" as Guid],
      east: [
        "egress-east-1" as Guid,
        "egress-east-2" as Guid,
        "egress-east-3" as Guid,
      ],
      west: [
        "egress-west-1" as Guid,
        "egress-west-2" as Guid,
        "egress-west-3" as Guid,
        "egress-west-4" as Guid,
      ],
    },
  });

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "requestIdentity",
    message: { region: "east" },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "requestIdentity",
    message: { region: "west" },
  });

  const peerIdA = firstMessageByType(h.wsA, "identity")!.message.peerId as Guid;
  const peerIdB = firstMessageByType(h.wsB, "identity")!.message.peerId as Guid;

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "joinRoom",
    message: { peerId: peerIdA, room: "demo-cross-region" },
  });
  await h.manager.incomingWebsocketSignal(h.wsidB, {
    type: "joinRoom",
    message: { peerId: peerIdB, room: "demo-cross-region" },
  });

  const roomAttachedA = firstMessageByType(h.wsA, "roomAttached");
  const roomAttachedB = firstMessageByType(h.wsB, "roomAttached");
  assert.ok(roomAttachedA);
  assert.ok(roomAttachedB);

  assert.deepEqual(roomAttachedA.message.egressServers, ["egress-east-1"]);
  assert.deepEqual(roomAttachedB.message.egressServers, [
    "egress-east-1",
    "egress-west-1",
  ]);

  const peerConnectedToA = parseWsMessages(h.wsA).find(
    (msg) => msg.type === "peerConnected" && msg.message.peerId === peerIdB,
  );
  assert.ok(peerConnectedToA);

  const peerA = requirePeer(h.manager, peerIdA);
  const peerB = requirePeer(h.manager, peerIdB);
  assert.equal(peerA.ingress, "ingress-east-1");
  assert.equal(peerA.egress, "egress-east-1");
  assert.equal(peerB.ingress, "ingress-west-1");
  assert.equal(peerB.egress, "egress-west-1");
});

test("multi-region: requestIdentity rejects unknown region", async () => {
  const h = createHarness({
    ingress: {
      east: ["ingress-east-1" as Guid],
      west: ["ingress-west-1" as Guid],
      north: ["ingress-north-1" as Guid],
      south: ["ingress-south-1" as Guid],
    },
    egress: {
      north: ["egress-north-1" as Guid],
      south: ["egress-south-1" as Guid, "egress-south-2" as Guid],
      east: [
        "egress-east-1" as Guid,
        "egress-east-2" as Guid,
        "egress-east-3" as Guid,
      ],
      west: [
        "egress-west-1" as Guid,
        "egress-west-2" as Guid,
        "egress-west-3" as Guid,
        "egress-west-4" as Guid,
      ],
    },
  });

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "requestIdentity",
    message: { region: "moon-base-1" },
  });

  const error = firstMessageByType(h.wsA, "error");
  assert.ok(error);
  assert.equal(error.message.error, "invalidRegion");
  assert.match(String(error.message.detail), /doesn't exist/);
});

test("multi-region: join fails when region has ingress but no egress capacity", async () => {
  const h = createHarness({
    ingress: { south: ["ingress-south-1" as Guid] },
    egress: {
      east: ["egress-east-1" as Guid],
      west: ["egress-west-1" as Guid],
      north: ["egress-north-1" as Guid],
    },
  });

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "requestIdentity",
    message: { region: "south" },
  });

  const identity = firstMessageByType(h.wsA, "identity");
  assert.ok(identity);
  const peerId = identity.message.peerId as Guid;

  await h.manager.incomingWebsocketSignal(h.wsidA, {
    type: "joinRoom",
    message: { peerId, room: "demo-south" },
  });

  const error = parseWsMessages(h.wsA)
    .filter((msg) => msg.type === "error")
    .at(-1);
  assert.ok(error);
  assert.equal(error.message.error, "requestFailed");
});

test(
  "multi-region: 100 peers converge across regional waves and mixed actions",
  { timeout: 20000 },
  async () => {
    const h = createScaleHarness(100, {
      ingress: {
        north: ["ingress-north-1" as Guid],
        south: ["ingress-south-1" as Guid],
        east: ["ingress-east-1" as Guid],
        west: ["ingress-west-1" as Guid],
      },
      egress: {
        north: ["egress-north-1" as Guid],
        south: ["egress-south-1" as Guid, "egress-south-2" as Guid],
        east: [
          "egress-east-1" as Guid,
          "egress-east-2" as Guid,
          "egress-east-3" as Guid,
        ],
        west: [
          "egress-west-1" as Guid,
          "egress-west-2" as Guid,
          "egress-west-3" as Guid,
          "egress-west-4" as Guid,
        ],
      },
    });

    const regions = ["north", "south", "east", "west"] as const;
    const room = "demo-multi-region-100";
    const peerIds = new Map<Guid, Guid>();

    // Wave 1: staggered identities across all regions.
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 3) % 17);
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "requestIdentity",
            message: { region: regions[idx % regions.length] },
          });
          const identity = firstMessageByType(peer.ws, "identity");
          assert.ok(identity);
          peerIds.set(peer.wsid, identity.message.peerId as Guid);
        })(),
      ),
    );

    // Wave 2: staggered joins.
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 5) % 23);
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "joinRoom",
            message: { peerId: peerIds.get(peer.wsid), room },
          });
        })(),
      ),
    );

    // Wave 3: request media (control-plane only, no actual media transport setup).
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 7) % 19);
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "requestRoomVideo",
            message: { requestingPeer: peerIds.get(peer.wsid) },
          });
        })(),
      ),
    );

    // Wave 4: media lifecycle actions mixed in (produce + close attempts).
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 9) % 27);
          const peerId = peerIds.get(peer.wsid);
          const mediaKind: "audio" | "video" = idx % 2 === 0 ? "audio" : "video";
          await h.manager.incomingWebsocketSignal(peer.wsid, {
            type: "produceMedia",
            message: {
              producingPeer: peerId,
              transportId: `ingress-transport-${idx}` as Guid,
              producerOptions: { kind: mediaKind, rtpParameters: {}, appData: {} },
              requestId: `req-${mediaKind}-${idx}`,
            },
          });

          if (idx % 4 === 0) {
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "producerClose",
              message: {
                originId: peer.wsid,
                producerId: `producer-${mediaKind}-${idx}` as Guid,
                mediaType: mediaKind,
              },
            });
          }
        })(),
      ),
    );

    // Wave 5: subset leaves + rejoins.
    const rejoinPeers = h.peers.filter((_, idx) => idx % 5 === 0);
    await Promise.all(
      rejoinPeers.map((peer, idx) =>
        (async () => {
          await wait((idx * 11) % 29);
          const peerId = peerIds.get(peer.wsid);
          try {
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "leaveRoom",
              message: { peerId, room },
            });
          } catch {
            // Timing waves intentionally overlap; rejected leave is acceptable here.
          }
          try {
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "joinRoom",
              message: { peerId, room },
            });
          } catch {
            // Timing waves intentionally overlap; rejected join is acceptable here.
          }
        })(),
      ),
    );

    // Wave 6: mixed graceful leave + disconnect.
    await Promise.all(
      h.peers.map((peer, idx) =>
        (async () => {
          await wait((idx * 13) % 31);
          const peerId = peerIds.get(peer.wsid);
          if (idx % 3 === 0) {
            try {
              await h.manager.incomingWebsocketSignal(peer.wsid, {
                type: "leaveRoom",
                message: { peerId, room },
              });
            } catch {
              // Timing waves intentionally overlap; rejected leave is acceptable here.
            }
          }
          try {
            await h.manager.incomingWebsocketSignal(peer.wsid, {
              type: "disconnectPeerWebsocket",
              message: { transport: peer.wsid, code: 1000 },
            });
          } catch {
            // Some peers may already be disconnected by overlap.
          }
        })(),
      ),
    );

    const allEvents = h.peers.flatMap((peer) => parseWsMessages(peer.ws));
    const errors = allEvents.filter((msg) => msg.type === "error");
    const errorCodes = errors.map((msg) => String(msg.message.error));
    const allowedErrorCodes = new Set([
      "roomEgressNotReady",
      "requestRejected",
      "requestFailed",
    ]);
    assert.ok(errorCodes.every((code) => allowedErrorCodes.has(code)));

    const identityCount = allEvents.filter((msg) => msg.type === "identity").length;
    const roomAttachedCount = allEvents.filter((msg) => msg.type === "roomAttached").length;
    assert.equal(identityCount, 100);
    assert.ok(roomAttachedCount >= 100);
  },
);

test(
  "multi-region: media-server response flow, readiness transition, fanout consistency, and failure injection",
  { timeout: 20000 },
  async () => {
    const h = createScaleHarness(8, {
      ingress: {
        north: ["ingress-north-1" as Guid],
        south: ["ingress-south-1" as Guid],
      },
      egress: {
        north: ["egress-north-1" as Guid],
        south: ["egress-south-1" as Guid, "egress-south-2" as Guid],
      },
    });

    const regions = ["north", "south"] as const;
    const room = "demo-multi-region-media-flow";
    const peerIds = new Map<Guid, Guid>();
    const ingressTransportByPeer = new Map<Guid, Guid>();
    for (let idx = 0; idx < h.peers.length; idx++) {
      const peer = h.peers[idx];
      const region = regions[idx % regions.length];
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "requestIdentity",
        message: { region },
      });
      const identity = firstMessageByType(peer.ws, "identity");
      assert.ok(identity, `missing identity for ${peer.wsid}`);
      const peerId = identity.message.peerId as Guid;
      peerIds.set(peer.wsid, peerId);
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "joinRoom",
        message: { peerId, room },
      });
    }

    // Before egress transport readiness, room media requests must be rejected.
    const earlyPeer = h.peers[0];
    const earlyPeerId = peerIds.get(earlyPeer.wsid)!;
    await h.manager.incomingWebsocketSignal(earlyPeer.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: earlyPeerId },
    });
    const earlyErrors = parseWsMessages(earlyPeer.ws).filter((msg) => msg.type === "error");
    assert.ok(
      earlyErrors.some((msg) => msg.message.error === "roomEgressNotReady"),
      "expected roomEgressNotReady before egress readiness",
    );
    // Simulate transport create/connect responses for ingress + all room egress servers.
    const roomEgressServers = ["egress-north-1", "egress-south-1", "egress-south-2"] as Guid[];
    for (let idx = 0; idx < h.peers.length; idx++) {
      const peer = h.peers[idx];
      const peerId = peerIds.get(peer.wsid)!;
      const peerData = requirePeer(h.manager, peerId);
      const ingressId = peerData.ingress as Guid;

      const ingressTransportId = `ingress-t-${idx}` as Guid;
      ingressTransportByPeer.set(peerId, ingressTransportId);
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "createIngress",
        message: {
          peerId,
          room,
          numStreams: { OS: 1, MIS: 1 },
          rtpCapabilities: { codecs: [], headerExtensions: [] },
          serverId: ingressId,
        },
      });
      h.manager.incomingNetsocketCommand(
        ingressId,
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
        h.ingressSockets.get(ingressId)!,
      );
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "connectIngress",
        message: { peerId, transportId: ingressTransportId, dtlsParameters: {} },
      });
      h.manager.incomingNetsocketCommand(
        ingressId,
        { type: "connectedWebRTCIngressTransport", message: { originId: peer.wsid } },
        h.ingressSockets.get(ingressId)!,
      );

      for (const egressId of roomEgressServers) {
        const egressTransportId = `${egressId}-t-${idx}` as Guid;
        await h.manager.incomingWebsocketSignal(peer.wsid, {
          type: "createEgress",
          message: {
            peerId,
            room,
            numStreams: { OS: 1, MIS: 1 },
            rtpCapabilities: { codecs: [], headerExtensions: [] },
            serverId: egressId,
          },
        });
        h.manager.incomingNetsocketCommand(
          egressId,
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
          h.egressSockets.get(egressId)!,
        );
        await h.manager.incomingWebsocketSignal(peer.wsid, {
          type: "connectEgress",
          message: {
            peerId,
            transportId: egressTransportId,
            dtlsParameters: {},
            serverId: egressId,
          },
        });
        h.manager.incomingNetsocketCommand(
          egressId,
          { type: "connectedWebRTCEgressTransport", message: { originId: peer.wsid } },
          h.egressSockets.get(egressId)!,
        );
      }
    }
    for (const peer of h.peers) {
      const ready = parseWsMessages(peer.ws).some((msg) => msg.type === "roomEgressReady");
      assert.ok(ready, `peer ${peer.wsid} did not receive roomEgressReady`);
    }
    // Produce from 3 peers and acknowledge from ingress.
    const producerPeers = h.peers.slice(0, 3);
    const producerIds = new Array<Guid>();
    for (let idx = 0; idx < producerPeers.length; idx++) {
      const peer = producerPeers[idx];
      const peerId = peerIds.get(peer.wsid)!;
      const peerData = requirePeer(h.manager, peerId);
      const ingressId = peerData.ingress as Guid;
      const producerId = `producer-video-${idx}` as Guid;
      producerIds.push(producerId);
      const requestId = `req-video-${idx}`;

      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "produceMedia",
        message: {
          producingPeer: peerId,
          transportId: ingressTransportByPeer.get(peerId)!,
          producerOptions: { kind: "video", rtpParameters: {}, appData: {} },
          requestId,
        },
      });
      h.manager.incomingNetsocketCommand(
        ingressId,
        {
          type: "createdMediaProducer",
          message: {
            originId: peer.wsid,
            producerId,
            kind: "video",
            rtpParameters: {},
            appData: {},
            requestId,
          },
        },
        h.ingressSockets.get(ingressId)!,
      );
    }
    for (const peer of producerPeers) {
      const produced = parseWsMessages(peer.ws).some((msg) => msg.type === "producedMedia");
      assert.ok(produced, `missing producedMedia ack for ${peer.wsid}`);
    }
    // Simulate one relay handshake from ingress->egress for first producer.
    const relayProducerPeer = peerIds.get(producerPeers[0].wsid)!;
    const relayProducerIngress = requirePeer(h.manager, relayProducerPeer).ingress as Guid;
    h.manager.incomingNetsocketCommand(
      relayProducerIngress,
      {
        type: "initializedNetworkRelay",
        message: {
          originId: producerPeers[0].wsid,
          routerNetwork: room,
          producerId: producerIds[0],
          consumerOptions: {},
          createNetworkPipeTransport: true,
          ingressIp: "127.0.0.1",
          ingressPort: 12001,
          protocol: "udp",
          appData: {},
          egressServer: "egress-south-1",
        },
      },
      h.ingressSockets.get(relayProducerIngress)!,
    );
    h.manager.incomingNetsocketCommand(
      "egress-south-1",
      {
        type: "connectedNetworkRelay",
        message: {
          originId: producerPeers[0].wsid,
          routerNetwork: room,
          producerId: producerIds[0],
          connectedTransport: true,
          egressIp: "127.0.0.1",
          egressPort: 12002,
          protocol: "udp",
          appData: {},
          ingressServer: relayProducerIngress,
        },
      },
      h.egressSockets.get("egress-south-1")!,
    );
    h.manager.incomingNetsocketCommand(
      relayProducerIngress,
      {
        type: "finalizedNetworkRelay",
        message: {
          originId: producerPeers[0].wsid,
          producerId: producerIds[0],
          routerNetwork: room,
          kind: "video",
          ingressIp: "127.0.0.1",
          ingressPort: 12001,
          egressIp: "127.0.0.1",
          egressPort: 12002,
          egressServer: "egress-south-1",
        },
      },
      h.ingressSockets.get(relayProducerIngress)!,
    );
    // Consume on one peer and assert fanout command consistency.
    const consumer = h.peers[7];
    const consumerPeerId = peerIds.get(consumer.wsid)!;
    await h.manager.incomingWebsocketSignal(consumer.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: consumerPeerId },
    });

    const createConsumerWrites = h.netsocketWrites.filter(
      (entry) => entry.payload.type === "createConsumer",
    );
    const consumerErrors = parseWsMessages(consumer.ws)
      .filter((msg) => msg.type === "error")
      .map((msg) => `${String(msg.message.error)}:${String(msg.message.detail ?? "")}`);
    assert.ok(
      createConsumerWrites.length > 0,
      `expected createConsumer writes; got 0 (producerIds=${producerIds.join(",")}, consumerErrors=${consumerErrors.join(" | ")})`,
    );
    const plannedProducerIds = new Set<string>();
    for (const write of createConsumerWrites) {
      const ids = (write.payload.message.producerIds ?? []) as Record<string, string[]>[];
      for (const group of ids) {
        for (const values of Object.values(group)) {
          values.forEach((id) => plannedProducerIds.add(id));
        }
      }
    }
    for (const producerId of producerIds) {
      assert.ok(
        plannedProducerIds.has(producerId),
        `missing planned producer ${producerId}`,
      );
    }
    // Deliver createdConsumer response and validate websocket announcement.
    const consumerTransportId = `egress-south-1-t-7` as Guid;
    h.manager.incomingNetsocketCommand(
      "egress-south-1",
      {
        type: "createdConsumer",
        message: {
          [consumerTransportId]: producerIds.map((producerId, idx) => ({
            id: `consumer-video-${idx}` as Guid,
            producerId,
            producerPeerId: peerIds.get(producerPeers[idx].wsid)!,
            kind: "video",
            rtpParameters: {},
            appData: {},
          })),
        },
      },
      h.egressSockets.get("egress-south-1")!,
    );
    const mediaAnnouncements = parseWsMessages(consumer.ws).filter(
      (msg) => msg.type === "mediaAnnouncement",
    );
    assert.ok(mediaAnnouncements.length > 0, "expected mediaAnnouncement after createdConsumer");
    // Failure injections: producerClosed + disconnectedWebRTCTransport.
    h.manager.incomingNetsocketCommand(
      relayProducerIngress,
      {
        type: "producerClosed",
        message: {
          originId: producerPeers[0].wsid,
          producerId: producerIds[0],
          mediaType: "video",
        },
      },
      h.ingressSockets.get(relayProducerIngress)!,
    );

    const writesBeforeClosedConsume = h.netsocketWrites.length;
    await h.manager.incomingWebsocketSignal(consumer.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: consumerPeerId },
    });
    const postCloseWrites = h.netsocketWrites
      .slice(writesBeforeClosedConsume)
      .filter((entry) => entry.payload.type === "createConsumer");
    const postCloseProducerIds = new Set<string>();
    for (const write of postCloseWrites) {
      const ids = (write.payload.message.producerIds ?? []) as Record<string, string[]>[];
      for (const group of ids) {
        for (const values of Object.values(group)) {
          values.forEach((id) => postCloseProducerIds.add(id));
        }
      }
    }
    assert.ok(
      !postCloseProducerIds.has(producerIds[0]),
      "closed producer should not be planned after producerClosed",
    );
    const disconnectTargetPeerId = peerIds.get(h.peers[1].wsid)!;
    h.manager.incomingNetsocketCommand(
      "egress-south-1",
      {
        type: "disconnectedWebRTCTransport",
        message: {
          transportId: `egress-south-1-t-1` as Guid,
          originId: h.peers[1].wsid,
          direction: "egress",
        },
      },
      h.egressSockets.get("egress-south-1")!,
    );
    const disconnectedPeer = requirePeer(h.manager, disconnectTargetPeerId);
    assert.equal(disconnectedPeer.mediaState, "failed");
  },
);
