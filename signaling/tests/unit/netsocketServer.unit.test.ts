import assert from "node:assert/strict";
import test from "node:test";
import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import {
  sendNetsocketSignal,
  type NetsocketTransportContext,
} from "../../lib/listeners/netsocketServer.js";

const createSocket = () => {
  let destroyed = false;
  let destroyError: Error | undefined;
  const socket = {
    destroy(error?: Error) {
      destroyed = true;
      destroyError = error;
    },
  } as unknown as NetSocket;
  return {
    socket,
    getDestroyed: () => destroyed,
    getDestroyError: () => destroyError,
  };
};

const createContext = (params: {
  serverId: Guid;
  socket: NetSocket;
  encoder: Transform;
}): NetsocketTransportContext => {
  const context: NetsocketTransportContext = {
    nsEncoders: new WeakMap<NetSocket, Transform>(),
    nsPendingWrites: new WeakMap<NetSocket, Buffer[]>(),
    nsBackpressuredSockets: new WeakSet<NetSocket>(),
    ingress: new Map<Guid, NetSocket>([[params.serverId, params.socket]]),
    egress: new Map<Guid, NetSocket>(),
  };
  context.nsEncoders.set(params.socket, params.encoder);
  return context;
};

test("netsocket send: write(false) does not destroy socket and later messages queue", () => {
  const { socket, getDestroyed } = createSocket();
  let writeCount = 0;
  const encoder = {
    write() {
      writeCount += 1;
      return writeCount > 1;
    },
  } as unknown as Transform;
  const serverId = "ingress-backpressure-1" as Guid;
  const context = createContext({ serverId, socket, encoder });

  assert.doesNotThrow(() => {
    sendNetsocketSignal(
      context,
      serverId,
      "ingress",
      "createRouterGroup",
      {
        room: "demo",
        origin: "ws-1" as Guid,
      },
    );
  });
  assert.equal(getDestroyed(), false);
  assert.equal(context.nsBackpressuredSockets.has(socket), true);
  assert.equal(context.nsPendingWrites.get(socket)?.length ?? 0, 0);
  assert.equal(writeCount, 1);

  assert.doesNotThrow(() => {
    sendNetsocketSignal(
      context,
      serverId,
      "ingress",
      "createRouterGroup",
      {
        room: "demo",
        origin: "ws-2" as Guid,
      },
    );
  });
  assert.equal(getDestroyed(), false);
  assert.equal(context.nsPendingWrites.get(socket)?.length ?? 0, 1);
  // Still one write call because second payload was buffered.
  assert.equal(writeCount, 1);
});

test("netsocket send: buffered queue overflow destroys socket and throws", () => {
  const { socket, getDestroyed, getDestroyError } = createSocket();
  let writeCount = 0;
  const encoder = {
    write() {
      writeCount += 1;
      return true;
    },
  } as unknown as Transform;
  const serverId = "ingress-backpressure-2" as Guid;
  const context = createContext({ serverId, socket, encoder });
  context.nsBackpressuredSockets.add(socket);

  let thrown: Error | undefined;
  for (let idx = 0; idx < 1025; idx += 1) {
    try {
      sendNetsocketSignal(
        context,
        serverId,
        "ingress",
        "createRouterGroup",
        {
          room: "demo",
          origin: `ws-${idx}` as Guid,
        },
      );
    } catch (error) {
      thrown = error instanceof Error ? error : new Error(String(error));
      break;
    }
  }

  assert.ok(thrown);
  assert.match(thrown.message, /buffered queue overflow/);
  assert.equal(getDestroyed(), true);
  assert.match(getDestroyError()?.message ?? "", /buffered queue overflow/);
  // Queueing under backpressure should not write directly to encoder.
  assert.equal(writeCount, 0);
});
