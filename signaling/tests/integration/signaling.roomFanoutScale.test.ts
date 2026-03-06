/**
 * Why this file exists:
 * - Room fanout scale can fail even when per-room behavior is correct.
 * - This suite validates many small rooms in one run (33 rooms x 3 peers)
 *   to confirm fanout planning and signaling behavior scales with room count.
 *
 * What this suite protects:
 * - 99 peers can be assigned identities and joined across 33 rooms.
 * - each room can establish producer -> consumer fanout for two consumers.
 * - total createConsumer planning volume matches expected room topology.
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

const requirePeer = (manager: Signaling, peerId: Guid): Peer => {
  const peer = manager.peers.get(peerId);
  assert.ok(peer, `missing peer ${peerId}`);
  return peer;
};

const createHarness = (peerCount: number) => {
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";

  const peers = Array.from({ length: peerCount }, (_, idx) => {
    const wsid = `ws-room-fanout-${idx + 1}` as Guid;
    return { wsid, ws: createFakeWs() };
  });

  const wsClients = new Map<Guid, unknown>(
    peers.map((peer) => [peer.wsid, peer.ws as unknown]),
  );

  const ingressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const egressSocket = { remoteAddress: "127.0.0.1", end() {} } as NetSocket;
  const ingress = new Map<Guid, NetSocket>([[ingressServerId, ingressSocket]]);
  const egress = new Map<Guid, NetSocket>([[egressServerId, egressSocket]]);

  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const netsocketWrites: Array<{
    node: string;
    payload: { type: string; message: Record<string, unknown> };
  }> = [];
  const encoder = {
    write(buffer: Buffer) {
      const parsed = JSON.parse(buffer.toString()) as {
        node?: string;
        payload?: { type: string; message: Record<string, unknown> };
        type?: string;
        message?: Record<string, unknown>;
      };
      netsocketWrites.push({
        node: parsed.node ?? "unknown",
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
    ingressServerId,
    egressServerId,
    ingressSocket,
    egressSocket,
    netsocketWrites,
    region,
  };
};

test(
  "room fanout scale: 99 peers across 33 rooms (3 per room) emits expected createConsumer fanout volume",
  { timeout: 30000 },
  async () => {
    const totalRooms = 33;
    const peersPerRoom = 3;
    const totalPeers = totalRooms * peersPerRoom;
    const h = createHarness(totalPeers);
    const peerIds = new Map<Guid, Guid>();
    const roomByPeerId = new Map<Guid, string>();

    // Identity for all peers.
    for (const peer of h.peers) {
      await h.manager.incomingWebsocketSignal(peer.wsid, {
        type: "requestIdentity",
        message: { region: h.region },
      });
      const identity = parseWsMessages(peer.ws).find((msg) => msg.type === "identity");
      assert.ok(identity, `missing identity for ${peer.wsid}`);
      peerIds.set(peer.wsid, identity.message.peerId as Guid);
    }

    // Room setup + fanout per room.
    for (let roomIndex = 0; roomIndex < totalRooms; roomIndex++) {
      const room = `room-${roomIndex + 1}`;
      const base = roomIndex * peersPerRoom;
      const roomPeers = h.peers.slice(base, base + peersPerRoom);
      const roomPeerIds = roomPeers.map((p) => peerIds.get(p.wsid)!);
      roomPeerIds.forEach((peerId) => roomByPeerId.set(peerId, room));

      // Join all peers in this room.
      for (const [idx, peer] of roomPeers.entries()) {
        await h.manager.incomingWebsocketSignal(peer.wsid, {
          type: "joinRoom",
          message: { peerId: roomPeerIds[idx], room },
        });
      }

      // Simulate egress transport creation for all 3 peers (needed for readiness/consume).
      for (const [idx, peer] of roomPeers.entries()) {
        h.manager.incomingNetsocketCommand(
          h.egressServerId,
          {
            type: "createdWebRTCEgressTransport",
            message: {
              originId: peer.wsid,
              transportId: `${room}-egress-${idx}` as Guid,
              iceParameters: {},
              iceCandidates: [],
              dtlsParameters: {},
            },
          },
          h.egressSocket,
        );
      }

      // Producer peer gets ingress transport.
      const producerPeer = roomPeers[0];
      const producerPeerId = roomPeerIds[0];
      const producerIngressTransportId = `${room}-ingress-0` as Guid;
      h.manager.incomingNetsocketCommand(
        h.ingressServerId,
        {
          type: "createdWebRTCIngressTransport",
          message: {
            originId: producerPeer.wsid,
            transportId: producerIngressTransportId,
            iceParameters: {},
            iceCandidates: [],
            dtlsParameters: {},
          },
        },
        h.ingressSocket,
      );

      // Mark all room peers as media-ready for consume path validation.
      for (const peerId of roomPeerIds) {
        const peer = requirePeer(h.manager, peerId);
        h.manager.peers.set(peerId, {
          ...peer,
          mediaState: "ready",
          deviceRTPCapabilities: { codecs: [], headerExtensions: [] },
        } as Peer);
      }

      // Create one producer in the room from peer0.
      const producerId = `${room}-producer-video-0` as Guid;
      await h.manager.incomingWebsocketSignal(producerPeer.wsid, {
        type: "produceMedia",
        message: {
          producingPeer: producerPeerId,
          transportId: producerIngressTransportId,
          producerOptions: { kind: "video", rtpParameters: {}, appData: {} },
          requestId: `${room}-req-video-0`,
        },
      });
      h.manager.incomingNetsocketCommand(
        h.ingressServerId,
        {
          type: "createdMediaProducer",
          message: {
            originId: producerPeer.wsid,
            producerId,
            kind: "video",
            rtpParameters: {},
            appData: {},
            requestId: `${room}-req-video-0`,
          },
        },
        h.ingressSocket,
      );

      // Remaining two peers request room video -> should each emit createConsumer.
      for (let i = 1; i < peersPerRoom; i++) {
        await h.manager.incomingWebsocketSignal(roomPeers[i].wsid, {
          type: "requestRoomVideo",
          message: { requestingPeer: roomPeerIds[i] },
        });
      }
    }

    // Signaling-level assertions under 99-peer / 33-room load.
    const allWsEvents = h.peers.flatMap((peer) => parseWsMessages(peer.ws));
    const identityCount = allWsEvents.filter((msg) => msg.type === "identity").length;
    const roomAttachedCount = allWsEvents.filter((msg) => msg.type === "roomAttached").length;
    const peerConnectedCount = allWsEvents.filter((msg) => msg.type === "peerConnected").length;
    const producedMediaCount = allWsEvents.filter((msg) => msg.type === "producedMedia").length;
    const roomEgressReadyCount = allWsEvents.filter((msg) => msg.type === "roomEgressReady").length;
    const errorEvents = allWsEvents.filter((msg) => msg.type === "error");

    // Per room, sequential 3-peer join emits 3 peerConnected messages total.
    assert.equal(identityCount, totalPeers);
    assert.equal(roomAttachedCount, totalPeers);
    assert.equal(peerConnectedCount, totalRooms * 3);
    assert.equal(producedMediaCount, totalRooms);
    assert.ok(roomEgressReadyCount >= totalPeers);
    assert.equal(
      errorEvents.length,
      0,
      `unexpected signaling errors: ${JSON.stringify(errorEvents.slice(0, 5))}`,
    );

    // Per-peer signaling correctness:
    // - peerConnected events must only reference peers from the same room.
    // - roomAttached roomPeers must only list already-present peers in the same room.
    for (const peer of h.peers) {
      const events = parseWsMessages(peer.ws);
      const selfPeerId = peerIds.get(peer.wsid);
      assert.ok(selfPeerId, `missing peerId mapping for ${peer.wsid}`);
      const selfRoom = roomByPeerId.get(selfPeerId);
      assert.ok(selfRoom, `missing room mapping for peer ${selfPeerId}`);

      const peerConnectedEvents = events.filter((msg) => msg.type === "peerConnected");
      for (const event of peerConnectedEvents) {
        const connectedPeer = event.message.peerId as Guid;
        assert.equal(
          roomByPeerId.get(connectedPeer),
          selfRoom,
          `cross-room peerConnected detected for peer=${selfPeerId}, connectedPeer=${connectedPeer}`,
        );
      }

      const roomAttached = events.find((msg) => msg.type === "roomAttached");
      assert.ok(roomAttached, `missing roomAttached for peer ${selfPeerId}`);
      const roomPeers = (roomAttached.message.roomPeers ?? []) as Guid[];
      for (const roomPeerId of roomPeers) {
        assert.equal(
          roomByPeerId.get(roomPeerId),
          selfRoom,
          `cross-room roomAttached peer detected for peer=${selfPeerId}, roomPeer=${roomPeerId}`,
        );
      }
    }

    // Expected fanout: 2 consumer requests per room for one producer.
    const createConsumerWrites = h.netsocketWrites.filter(
      (entry) => entry.payload.type === "createConsumer",
    );
    assert.equal(createConsumerWrites.length, totalRooms * 2);

    // Every room's producer should appear in planned createConsumer payloads.
    const plannedProducerIds = new Set<string>();
    for (const write of createConsumerWrites) {
      const ids = (write.payload.message.producerIds ?? []) as Record<string, string[]>[];
      for (const group of ids) {
        for (const values of Object.values(group)) {
          values.forEach((id) => plannedProducerIds.add(id));
        }
      }
    }

    for (let roomIndex = 0; roomIndex < totalRooms; roomIndex++) {
      const roomProducerId = `room-${roomIndex + 1}-producer-video-0`;
      assert.ok(
        plannedProducerIds.has(roomProducerId),
        `missing planned producer ${roomProducerId}`,
      );
    }
  },
);
