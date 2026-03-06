/**
 * Why this file exists:
 * - We need a baseline where no peers are connected at all.
 * - This isolates media-server lifecycle behavior from peer/session complexity.
 * - Regressions here can break control-plane startup before any user joins.
 *
 * What this suite protects:
 * - ingress/egress register/load/unregister flow.
 * - graceful socket end behavior on unregister.
 * - guarantee that zero-peer operations do not emit peer websocket events.
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

type FakeSocket = {
  endCalled: boolean;
  remoteAddress: string;
  end: () => void;
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

const createSocket = (remoteAddress: string): FakeSocket => ({
  endCalled: false,
  remoteAddress,
  end() {
    this.endCalled = true;
  },
});

const parseWsMessages = (socket: FakeWs) =>
  socket.sent.map(
    (entry) => JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

test("zero-peer baseline: media server registration/load/unregister only", async () => {
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;
  const region = "local";

  const ws = createFakeWs();
  const wsClients = new Map<Guid, unknown>([["unused-ws" as Guid, ws as unknown]]);

  const ingressSocket = createSocket("127.0.0.1");
  const egressSocket = createSocket("127.0.0.1");
  const ingress = new Map<Guid, NetSocket>([
    [ingressServerId, ingressSocket as unknown as NetSocket],
  ]);
  const egress = new Map<Guid, NetSocket>([
    [egressServerId, egressSocket as unknown as NetSocket],
  ]);

  const nsEncoders = new WeakMap<NetSocket, Transform>();
  const encoder = { write(_buffer: Buffer) { return true; } } as unknown as Transform;
  nsEncoders.set(ingressSocket as unknown as NetSocket, encoder);
  nsEncoders.set(egressSocket as unknown as NetSocket, encoder);

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
    ingressLoadDetail: { [region]: { [ingressServerId]: { avg: 1, perCpu: [] } } },
    egressLoadDetail: { [region]: { [egressServerId]: { avg: 1, perCpu: [] } } },
  });

  manager.incomingNetsocketCommand(
    ingressServerId,
    { type: "registerMediaServer", message: { registrationId: ingressServerId, mode: "ingress", region } },
    ingressSocket as unknown as NetSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    { type: "registerMediaServer", message: { registrationId: egressServerId, mode: "egress", region } },
    egressSocket as unknown as NetSocket,
  );

  manager.incomingNetsocketCommand(
    ingressServerId,
    {
      type: "serverLoad",
      message: { mode: "ingress", region, load: 7, loadPerCpu: [6, 8] },
    },
    ingressSocket as unknown as NetSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    {
      type: "serverLoad",
      message: { mode: "egress", region, load: 5, loadPerCpu: [4, 6] },
    },
    egressSocket as unknown as NetSocket,
  );

  manager.incomingNetsocketCommand(
    ingressServerId,
    {
      type: "unregisterMediaServer",
      message: { mode: "ingress", region, reason: "maintenance" },
    },
    ingressSocket as unknown as NetSocket,
  );
  manager.incomingNetsocketCommand(
    egressServerId,
    {
      type: "unregisterMediaServer",
      message: { mode: "egress", region, reason: "maintenance" },
    },
    egressSocket as unknown as NetSocket,
  );

  // In zero-peer scope, no peer/websocket state transitions should occur.
  assert.equal(parseWsMessages(ws).length, 0);

  assert.equal(ingressSocket.endCalled, true);
  assert.equal(egressSocket.endCalled, true);
});
