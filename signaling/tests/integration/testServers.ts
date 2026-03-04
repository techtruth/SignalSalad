import type { Socket as NetSocket } from "node:net";
import type { Transform } from "node:stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import {
  createNetsocketServer,
  type NetsocketServer,
} from "../../lib/listeners/netsocketServer.js";
import {
  createWebSocketServer,
  type IdentifiedWebSocket,
  type WebSocketServer,
} from "../../lib/listeners/websocketServer.js";

type CreateTestServersArgs = {
  wsClients?: Map<Guid, unknown>;
  statusSubscribers?: Set<Guid>;
  nsEncoders?: WeakMap<NetSocket, Transform>;
  ingress?: Map<Guid, NetSocket>;
  egress?: Map<Guid, NetSocket>;
};

type TestServers = {
  websocketServer: WebSocketServer;
  netsocketServer: NetsocketServer;
};

/**
 * Builds transport adapters for tests while allowing direct inspection
 * of caller-owned maps/sockets used by assertions.
 */
export const createTestServers = (
  args: CreateTestServersArgs = {},
): TestServers => {
  const websocketServer = createWebSocketServer({
    wsClients: (args.wsClients ??
      new Map<Guid, unknown>()) as Map<Guid, IdentifiedWebSocket>,
    statusSubscribers: args.statusSubscribers ?? new Set<Guid>(),
  });

  const netsocketServer = createNetsocketServer({
    nsEncoders: args.nsEncoders ?? new WeakMap<NetSocket, Transform>(),
    ingress: args.ingress ?? new Map<Guid, NetSocket>(),
    egress: args.egress ?? new Map<Guid, NetSocket>(),
  });

  return {
    websocketServer,
    netsocketServer,
  };
};
