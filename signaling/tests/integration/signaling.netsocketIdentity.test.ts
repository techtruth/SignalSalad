/**
 * Why this file exists:
 * - The signaling server trusts netsocket messages only after identity registration.
 * - If this contract regresses, any media node could spoof server identity, mode, or lifecycle commands.
 * - These tests lock down command-level trust boundaries and ensure misuse fails loudly.
 *
 * What this suite protects:
 * - "register first" requirement for all non-register commands.
 * - duplicate/reserved identity rejection.
 * - mode consistency and node ownership enforcement.
 * - unregister semantics and offline-event retention/TTL behavior.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { Socket as NetSocket } from "node:net";

import Signaling from "../../lib/signaling/signaling.js";
import { getSignalingRuntime } from "./runtimeAccess.js";
import { createTestServers } from "./testServers.js";

type FakeSocket = {
  endCalled: boolean;
  end: () => void;
};

type SignalingRuntimeView = {
  stores: {
    serverOfflineEvents: Record<
      string,
      {
        mode: "ingress" | "egress";
        region?: string;
        graceful: boolean;
        reason?: string;
        detail?: string;
        trigger: string;
        at: string;
      }
    >;
  };
};

const getServerOfflineEvents = (manager: Signaling) =>
  getSignalingRuntime<SignalingRuntimeView>(manager).stores.serverOfflineEvents;

const createManager = () => new Signaling(createTestServers());

const createSocket = (): FakeSocket => ({
  endCalled: false,
  end() {
    this.endCalled = true;
  },
});

const asSocket = (socket: FakeSocket) => socket as unknown as NetSocket;

test("netsocket must register before sending non-register message", () => {
  const manager = createManager();
  const connection = createSocket();

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "serverLoad",
          message: { mode: "ingress", region: "local", load: 1 },
        },
        asSocket(connection),
      ),
    /must registerMediaServer before sending messages/,
  );
});

test("registerMediaServer rejects duplicate server id on different connection", () => {
  const manager = createManager();
  const firstConnection = createSocket();
  const secondConnection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(firstConnection),
  );

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "registerMediaServer",
          message: {
            registrationId: "media-1",
            mode: "ingress",
            region: "local",
          },
        },
        asSocket(secondConnection),
      ),
    /already registered on a different ingress connection/,
  );
});

test("registerMediaServer rejects reserved signaling node id", () => {
  const manager = createManager();
  const connection = createSocket();

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "signaling",
        {
          type: "registerMediaServer",
          message: {
            registrationId: "signaling",
            mode: "ingress",
            region: "local",
          },
        },
        asSocket(connection),
      ),
    /reserved node id 'signaling' is not valid for media servers/,
  );
});

test("registerMediaServer rejects mismatched registrationId and node", () => {
  const manager = createManager();
  const connection = createSocket();

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "registerMediaServer",
          message: {
            registrationId: "media-2",
            mode: "ingress",
            region: "local",
          },
        },
        asSocket(connection),
      ),
    /registrationId must match envelope node/,
  );
});

test("registerMediaServer rejects same server id across ingress and egress on different connections", () => {
  const manager = createManager();
  const ingressConnection = createSocket();
  const egressConnection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(ingressConnection),
  );

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "registerMediaServer",
          message: {
            registrationId: "media-1",
            mode: "egress",
            region: "local",
          },
        },
        asSocket(egressConnection),
      ),
    /already registered as ingress on a different connection/,
  );
});

test("registered connection cannot spoof another node id", () => {
  const manager = createManager();
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "egress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-2",
        {
          type: "serverLoad",
          message: { mode: "egress", region: "local", load: 10 },
        },
        asSocket(connection),
      ),
    /node id does not match registered connection identity/,
  );
});

test("registered connection must keep message mode consistent", () => {
  const manager = createManager();
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "serverLoad",
          message: { mode: "egress", region: "local", load: 10 },
        },
        asSocket(connection),
      ),
    /mode does not match registered connection mode/,
  );
});

test("registered connection must keep mediaDiagnostic mode consistent", () => {
  const manager = createManager();
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "mediaDiagnostic",
          message: {
            mode: "egress",
            region: "local",
            severity: "warn",
            category: "mediaServerLifecycle",
            message: "test mismatch",
          },
        },
        asSocket(connection),
      ),
    /mode does not match registered connection mode/,
  );
});

test("registered connection can publish mediaDiagnostic with matching mode", () => {
  const manager = createManager();
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  assert.doesNotThrow(() =>
    manager.incomingNetsocketCommand(
      "media-1",
      {
        type: "mediaDiagnostic",
        message: {
          mode: "ingress",
          region: "local",
          severity: "warn",
          category: "transportLifecycle",
          message: "stats sample missing",
          details: "transportId=t-1",
          context: {
            transportId: "t-1",
          },
        },
      },
      asSocket(connection),
    ),
  );
});

test("unregisterMediaServer rejects non-registered connection", () => {
  const manager = createManager();
  const registeredConnection = createSocket();
  const wrongConnection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(registeredConnection),
  );

  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "unregisterMediaServer",
          message: {
            mode: "ingress",
            region: "local",
            reason: "maintenance",
          },
        },
        asSocket(wrongConnection),
      ),
    /connection must registerMediaServer before sending messages/,
  );
});

test("unregisterMediaServer gracefully ejects and ends connection", () => {
  const manager = createManager();
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "unregisterMediaServer",
      message: {
        mode: "ingress",
        region: "local",
        reason: "maintenance",
      },
    },
    asSocket(connection),
  );

  assert.equal(connection.endCalled, true);
  assert.throws(
    () =>
      manager.incomingNetsocketCommand(
        "media-1",
        {
          type: "serverLoad",
          message: { mode: "ingress", region: "local", load: 12 },
        },
        asSocket(connection),
      ),
    /must registerMediaServer before sending messages/,
  );
});

test("unregisterMediaServer keeps server offline metadata when reason/detail are provided", () => {
  const manager = createManager();
  const serverOfflineEvents = getServerOfflineEvents(manager);
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "egress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "unregisterMediaServer",
      message: {
        mode: "egress",
        region: "local",
        reason: "server_shutdown",
        detail: "draining for rollout",
      },
    },
    asSocket(connection),
  );

  assert.equal(connection.endCalled, true);
  assert.equal(serverOfflineEvents["media-1"]?.mode, "egress");
  assert.equal(serverOfflineEvents["media-1"]?.region, "local");
  assert.equal(serverOfflineEvents["media-1"]?.graceful, true);
  assert.equal(serverOfflineEvents["media-1"]?.reason, "server_shutdown");
  assert.equal(serverOfflineEvents["media-1"]?.detail, "draining for rollout");
  assert.equal(
    serverOfflineEvents["media-1"]?.trigger,
    "unregisterMediaServer",
  );
});

test("serverOfflineEvents TTL prunes entries older than one minute", () => {
  const staleAt = new Date(Date.now() - 61_000).toISOString();
  const freshAt = new Date(Date.now() - 1_000).toISOString();
  const seedEvents = {
    stale: {
      mode: "ingress" as const,
      region: "local",
      graceful: false,
      reason: "socket_closed",
      trigger: "test",
      at: staleAt,
    },
    fresh: {
      mode: "egress" as const,
      region: "local",
      graceful: true,
      reason: "maintenance",
      trigger: "test",
      at: freshAt,
    },
  };
  const manager = createManager();
  const serverOfflineEvents = getServerOfflineEvents(manager);
  Object.assign(serverOfflineEvents, seedEvents);
  const connection = createSocket();

  manager.incomingNetsocketCommand(
    "media-1",
    {
      type: "registerMediaServer",
      message: {
        registrationId: "media-1",
        mode: "ingress",
        region: "local",
      },
    },
    asSocket(connection),
  );

  assert.equal("stale" in serverOfflineEvents, false);
  assert.equal("fresh" in serverOfflineEvents, true);
});
