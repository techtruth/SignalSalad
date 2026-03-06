import assert from "node:assert/strict";
import test from "node:test";
import type { Guid } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import { getSignalingRuntime } from "./runtimeAccess.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  closeCalls: Array<{ code?: number; reason?: string }>;
  send: (payload: string) => void;
  close: (code?: number, reason?: string) => void;
};

type SignalingRuntimeView = {
  ports: {
    statusReporter: { broadcastStatus: () => Promise<void> };
  };
};

const getRuntime = (manager: Signaling) =>
  getSignalingRuntime<SignalingRuntimeView>(manager);

const createFakeWs = (): FakeWs => ({
  sent: [],
  closeCalls: [],
  send(payload: string) {
    this.sent.push(payload);
  },
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    // No-op in test harness.
  },
});

const createThrowingWs = (): FakeWs => ({
  sent: [],
  closeCalls: [],
  send(_payload: string) {
    throw new Error("simulated ws send failure");
  },
  close(code?: number, reason?: string) {
    this.closeCalls.push({ code, reason });
    // No-op in test harness.
  },
});

const parseMessages = (ws: FakeWs) =>
  ws.sent.map(
    (entry) => JSON.parse(entry) as { type: string; message: Record<string, unknown> },
  );

test("systemStatus includes recent diagnostics from websocket and netsocket failures", async () => {
  const statusWsid = "ws-status" as Guid;
  const peerWsid = "ws-peer-1" as Guid;
  const statusWs = createFakeWs();
  const peerWs = createFakeWs();

  const wsClients = new Map<Guid, never>([
    [statusWsid, statusWs as never],
    [peerWsid, peerWs as never],
  ]);
  const statusSubscribers = new Set<Guid>([statusWsid]);

  const servers = createTestServers({
    wsClients,
    statusSubscribers,
  });

  const manager = new Signaling({
    ...servers,
  });

  await manager.incomingWebsocketSignal(peerWsid, {
    type: "joinRoom",
    message: { peerId: "unknown-peer" as Guid, room: "demo" },
  });

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1" as Guid,
        { type: "serverLoad", message: { mode: "ingress", region: "local", load: 1 } },
        {} as never,
      ),
    /connection must registerMediaServer/,
  );

  const mediaConnection = {} as never;
  manager.incomingNetsocketCommand(
    "media-1" as Guid,
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    mediaConnection,
  );
  manager.incomingNetsocketCommand(
    "media-1" as Guid,
    {
      type: "mediaDiagnostic",
      message: {
        mode: "ingress",
        region: "local",
        severity: "warn",
        category: "transportLifecycle",
        message: "transport stats unavailable",
        details: "transportId=t-1",
        context: { transportId: "t-1" },
      },
    },
    mediaConnection,
  );

  await getRuntime(manager).ports.statusReporter.broadcastStatus();

  const statusMessage = parseMessages(statusWs).find(
    (entry) => entry.type === "systemStatus",
  );
  assert.ok(statusMessage);

  const diagnostics = statusMessage.message.diagnosticsRecent as Array<{
    category: string;
    message: string;
    details?: string;
  }>;
  assert.ok(Array.isArray(diagnostics));
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "websocketRequest" &&
        entry.message.includes("joinRoom"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "netsocketCommand" &&
        entry.message.includes("serverLoad"),
    ),
  );
  assert.ok(
    diagnostics.some(
      (entry) =>
        entry.category === "transportLifecycle" &&
        entry.message.includes("transport stats unavailable"),
    ),
  );
});

test("systemStatus prunes status subscribers that fail websocket send", async () => {
  const statusWsid = "ws-status-bad" as Guid;
  const statusWs = createThrowingWs();
  const wsClients = new Map<Guid, never>([[statusWsid, statusWs as never]]);
  const statusSubscribers = new Set<Guid>([statusWsid]);

  const servers = createTestServers({
    wsClients,
    statusSubscribers,
  });

  const manager = new Signaling({
    ...servers,
  });

  await getRuntime(manager).ports.statusReporter.broadcastStatus();

  assert.equal(servers.websocketServer.getStatusSubscribers().has(statusWsid), false);
  assert.equal(servers.websocketServer.getClients().has(statusWsid), false);
  assert.equal(statusWs.closeCalls.length, 1);
  assert.equal(statusWs.closeCalls[0]?.code, 1011);
});
