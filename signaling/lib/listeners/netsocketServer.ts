/**
 * Netsocket listener adapter for signaling <-> media-server transport.
 *
 * Responsibilities:
 * - accept TCP media-server connections,
 * - decode length-prefixed JSON envelopes,
 * - validate payload shape before dispatch,
 * - manage outbound backpressure queues per socket.
 */
import type { Socket as NetSocket } from "net";
import type { Transform } from "stream";

import type { Guid } from "../../../types/baseTypes.d.ts";
import type { SystemDiagnosticEvent } from "../../../types/wsRelay.d.ts";
import type { TracePayload } from "../observability/trace.js";
import { traceNsIn, traceNsOut } from "../observability/trace.js";
import {
  isBidirectionalMediaSignalWrapper,
  type MediaInboundPayload,
  type NodeId,
  type NsMessageMap,
} from "../protocol/signalingIoValidation.js";
import { formatServerAddress } from "./serverAddress.js";

import * as lps from "length-prefixed-stream";
import * as net from "net";

/** Outbound netsocket envelope payload for typed send operations. */
type NsSignalPayload<T extends keyof NsMessageMap> = {
  type: T;
  message: NsMessageMap[T];
};

/**
 * Netsocket server handlers consumed by the signaling coordinator.
 */
export type NetsocketHandlers = {
  onSignal: (
    node: NodeId,
    payload: MediaInboundPayload,
    connection: NetSocket,
  ) => void;
  onClose: (connection: NetSocket) => void;
  onDiagnostic?: (event: Omit<SystemDiagnosticEvent, "at">) => void;
};

/**
 * Mutable transport indexes backing netsocket delivery and backpressure state.
 *
 * - `nsEncoders`: socket -> length-prefixed encoder stream
 * - `nsPendingWrites`: socket -> queued encoded payloads while backpressured
 * - `nsBackpressuredSockets`: sockets currently waiting for encoder drain
 * - `ingress`/`egress`: media-server id -> active TCP socket
 */
export type NetsocketTransportContext = {
  nsEncoders: WeakMap<NetSocket, Transform>;
  nsPendingWrites: WeakMap<NetSocket, Buffer[]>;
  nsBackpressuredSockets: WeakSet<NetSocket>;
  ingress: Map<Guid, NetSocket>;
  egress: Map<Guid, NetSocket>;
};

/** Media-server channel selector used by netsocket server lookups and sends. */
export type NetsocketServerMode = "ingress" | "egress";
/** Optional netsocket bind overrides. */
export type NetsocketServerOptions = {
  host?: string;
  port?: number;
};

const DEFAULT_NETSOCKET_HOST = "0.0.0.0";
const DEFAULT_NETSOCKET_PORT = 1188;
/** Hard cap for buffered outbound frames per backpressured socket. */
const MAX_PENDING_NETSOCKET_WRITES = 1024;

/**
 * Removes a closing socket from ingress/egress lookup maps.
 *
 * @param context Mutable netsocket transport indexes.
 * @param connection Closing socket reference.
 */
const pruneClosedConnectionFromServerMaps = (
  context: NetsocketTransportContext,
  connection: NetSocket,
) => {
  for (const [serverId, socket] of context.ingress.entries()) {
    if (socket === connection) {
      context.ingress.delete(serverId);
    }
  }
  for (const [serverId, socket] of context.egress.entries()) {
    if (socket === connection) {
      context.egress.delete(serverId);
    }
  }
};

/**
 * Queues a serialized frame for later encoder flush.
 *
 * When the queue exceeds the hard cap, the socket is destroyed to prevent
 * unbounded memory growth under persistent backpressure.
 *
 * @param params Queueing context and encoded frame.
 * @throws {Error} When buffered queue exceeds safety cap.
 */
const queueNetsocketWrite = (params: {
  context: NetsocketTransportContext;
  socket: NetSocket;
  channel: "ingress" | "egress";
  destinationNode: Guid;
  encodedSignal: Buffer;
}) => {
  const { context, socket, channel, destinationNode, encodedSignal } = params;
  const queue = context.nsPendingWrites.get(socket) ?? [];
  queue.push(encodedSignal);
  context.nsPendingWrites.set(socket, queue);

  if (queue.length > MAX_PENDING_NETSOCKET_WRITES) {
    context.nsPendingWrites.delete(socket);
    context.nsBackpressuredSockets.delete(socket);
    const overflowError = new Error(
      `${channel} encoder buffered queue overflow for ${destinationNode}`,
    );
    socket.destroy(overflowError);
    throw overflowError;
  }
};

/**
 * Attempts to flush queued frames after encoder `drain`.
 *
 * If a write returns `false`, the socket remains marked as backpressured and
 * remaining queued frames stay buffered for the next `drain`.
 *
 * @param context Mutable netsocket transport indexes.
 * @param socket Target socket being drained.
 * @param encoder Encoder stream bound to socket.
 */
const flushPendingNetsocketWrites = (
  context: NetsocketTransportContext,
  socket: NetSocket,
  encoder: Transform,
) => {
  const queue = context.nsPendingWrites.get(socket);
  if (!queue || queue.length === 0) {
    context.nsPendingWrites.delete(socket);
    context.nsBackpressuredSockets.delete(socket);
    return;
  }

  while (queue.length > 0) {
    const next = queue[0];
    const didBufferAcceptWrite = encoder.write(next);
    if (!didBufferAcceptWrite) {
      context.nsBackpressuredSockets.add(socket);
      return;
    }
    queue.shift();
  }

  context.nsPendingWrites.delete(socket);
  context.nsBackpressuredSockets.delete(socket);
};

/**
 * Adapter interface for media-server netsocket server lifecycle + delivery.
 *
 * The signaling orchestration layer depends on this interface rather than
 * directly managing encoder/socket internals.
 */
export type NetsocketServer = {
  /** Boots TCP netsocket listener and wires handlers. */
  setup(handlers: NetsocketHandlers, options?: NetsocketServerOptions): void;
  /** Sends one typed netsocket message to a server in selected channel. */
  send<T extends keyof NsMessageMap>(
    destinationNode: Guid,
    channel: NetsocketServerMode,
    type: T,
    message: NsMessageMap[T],
  ): void;
  getServersByMode(mode: NetsocketServerMode): Map<Guid, NetSocket>;
};

/** Optional dependency injection hooks for tests/custom adapters. */
export type NetsocketServerDeps = {
  nsEncoders?: WeakMap<NetSocket, Transform>;
  nsPendingWrites?: WeakMap<NetSocket, Buffer[]>;
  nsBackpressuredSockets?: WeakSet<NetSocket>;
  ingress?: Map<Guid, NetSocket>;
  egress?: Map<Guid, NetSocket>;
};

/**
 * Sets up the media-server TCP signaling channel (length-prefixed JSON).
 *
 * Responsibilities:
 * - accept media server connections
 * - decode/validate inbound envelopes
 * - route valid payloads to signaling handlers
 * - keep encoder/socket indexes in sync on close/error
 * - flush deferred outbound frames on encoder drain
 *
 * @param context Mutable transport indexes used by adapter internals.
 * @param handlers Signaling callback handlers for netsocket lifecycle.
 * @param options Optional bind host/port overrides.
 */
export const setupNetsocketServer = (
  context: NetsocketTransportContext,
  handlers: NetsocketHandlers,
  options: NetsocketServerOptions = {},
) => {
  const host = options.host ?? DEFAULT_NETSOCKET_HOST;
  const port = options.port ?? DEFAULT_NETSOCKET_PORT;
  const netsocketServer = net.createServer((connection: NetSocket) => {
    console.log("New media server connected from", connection.remoteAddress);
    const decoder: Transform = lps.decode();
    const encoder: Transform = lps.encode();
    context.nsEncoders.set(connection, encoder);
    connection.pipe(decoder);
    encoder.pipe(connection);

    decoder.on("error", (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      handlers.onDiagnostic?.({
        severity: "warn",
        category: "netsocketCommand",
        message: "netsocket decode error",
        details: errorMessage,
        context: {
          remoteAddress: connection.remoteAddress ?? "unknown",
        },
      });
      console.error("Netsocket decode error", err);
      connection.destroy(err);
    });

    encoder.on("error", (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      handlers.onDiagnostic?.({
        severity: "warn",
        category: "netsocketCommand",
        message: "netsocket encode error",
        details: errorMessage,
        context: {
          remoteAddress: connection.remoteAddress ?? "unknown",
        },
      });
      console.error("Netsocket encode error", err);
      connection.destroy(err);
    });

    encoder.on("drain", () => {
      try {
        flushPendingNetsocketWrites(context, connection, encoder);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "netsocketCommand",
          message: "netsocket buffered flush failed",
          details: errorMessage,
          context: {
            remoteAddress: connection.remoteAddress ?? "unknown",
          },
        });
        connection.destroy(
          err instanceof Error ? err : new Error(errorMessage),
        );
      }
    });

    connection.on("error", (err) => {
      const errorMessage = err instanceof Error ? err.message : String(err);
      handlers.onDiagnostic?.({
        severity: "warn",
        category: "netsocketCommand",
        message: "netsocket connection error",
        details: errorMessage,
        context: {
          remoteAddress: connection.remoteAddress ?? "unknown",
        },
      });
      console.log(
        "Error in connection to media server",
        connection.remoteAddress,
        err,
      );
      connection.destroy(err);
    });

    connection.on("close", () => {
      console.log("Server connection closed!");
      context.nsEncoders.delete(connection);
      context.nsPendingWrites.delete(connection);
      context.nsBackpressuredSockets.delete(connection);
      let closeHandlerErrorMessage: string | undefined;
      try {
        handlers.onClose(connection);
      } catch (error) {
        closeHandlerErrorMessage =
          error instanceof Error ? error.message : String(error);
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "netsocketCommand",
          message: "netsocket close handler failed",
          details: closeHandlerErrorMessage,
          context: {
            remoteAddress: connection.remoteAddress ?? "unknown",
          },
        });
        console.error("Netsocket close handler failed", {
          remoteAddress: connection.remoteAddress,
          error: closeHandlerErrorMessage,
        });
      }
      pruneClosedConnectionFromServerMaps(context, connection);
    });

    connection.on("end", () => {
      console.log("Ended signal transport from api server to media server");
    });

    decoder.on("data", (buffer: Buffer) => {
      let parsedMessage: unknown;
      try {
        parsedMessage = JSON.parse(buffer.toString());
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "netsocketCommand",
          message: "invalid netsocket JSON payload",
          details: errorMessage,
          context: {
            remoteAddress: connection.remoteAddress ?? "unknown",
          },
        });
        console.error(
          "Cannot parse incoming netsocket message!",
          err,
          buffer.toString(),
        );
        connection.destroy(
          err instanceof Error ? err : new Error("Invalid netsocket JSON"),
        );
        return;
      }
      if (!isBidirectionalMediaSignalWrapper(parsedMessage)) {
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "netsocketCommand",
          message: "invalid netsocket message shape",
          details: "payload failed netsocket envelope validation",
          context: {
            remoteAddress: connection.remoteAddress ?? "unknown",
          },
        });
        console.error("Invalid netsocket message shape", parsedMessage);
        connection.destroy(new Error("Invalid netsocket signal wrapper"));
        return;
      }
      try {
        traceNsIn(parsedMessage.node, parsedMessage.payload as TracePayload);
        handlers.onSignal(
          parsedMessage.node,
          parsedMessage.payload,
          connection,
        );
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "netsocketCommand",
          message: "netsocket command handler failed",
          details: errorMessage,
          context: {
            node: parsedMessage.node,
            messageType: parsedMessage.payload.type,
          },
        });
        console.error(
          "Error executing incoming netsocket command",
          err,
          parsedMessage,
        );
        connection.destroy(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });

  netsocketServer.listen({ port, host }, () => {
    const address = netsocketServer.address();
    console.log(
      `Netsocket Signaling is listening on ${formatServerAddress(address)}`,
    );
  });
};

/**
 * Sends a typed netsocket payload to a registered media server channel.
 *
 * Throws when destination socket/encoder mappings are missing so signaling
 * can classify the error and emit actionable diagnostics. Under backpressure,
 * payloads are buffered and flushed on `drain` rather than failing immediately.
 *
 * @param context Mutable transport indexes used for routing + backpressure.
 * @param destinationNode Target media-server id.
 * @param channel Media-server channel (`ingress` or `egress`).
 * @param type Outbound netsocket message type.
 * @param message Typed outbound message payload.
 * @throws {Error} When destination/encoder is missing or write fails.
 */
export const sendNetsocketSignal = <T extends keyof NsMessageMap>(
  context: NetsocketTransportContext,
  destinationNode: Guid,
  channel: "ingress" | "egress",
  type: T,
  message: NsMessageMap[T],
) => {
  const socket =
    channel === "ingress"
      ? context.ingress.get(destinationNode)
      : context.egress.get(destinationNode);
  if (!socket) {
    throw new Error(`${channel} server missing for send ${destinationNode}`);
  }
  const encoder = context.nsEncoders.get(socket);
  if (!encoder) {
    throw new Error(`${channel} encoder missing for ${destinationNode}`);
  }
  const payload: NsSignalPayload<T> = { type, message };
  const signal = { node: "signaling", payload };
  const encodedSignal = Buffer.from(JSON.stringify(signal));
  try {
    traceNsOut(destinationNode, signal.payload as unknown as TracePayload);
  } catch (error) {
    console.warn("Netsocket outbound trace failed", {
      destinationNode,
      channel,
      messageType: type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    context.nsBackpressuredSockets.has(socket) ||
    (context.nsPendingWrites.get(socket)?.length ?? 0) > 0
  ) {
    queueNetsocketWrite({
      context,
      socket,
      channel,
      destinationNode,
      encodedSignal,
    });
    return;
  }
  try {
    const didBufferAcceptWrite = encoder.write(encodedSignal);
    if (!didBufferAcceptWrite) {
      context.nsBackpressuredSockets.add(socket);
    }
  } catch (error) {
    const normalizedError =
      error instanceof Error ? error : new Error(String(error));
    socket.destroy(normalizedError);
    throw new Error(
      `${channel} encoder write failed for ${destinationNode}: ${normalizedError.message}`,
    );
  }
};

/**
 * Creates a netsocket transport adapter with isolated in-memory encoder/socket
 * state and per-socket backpressure buffers.
 *
 * @param deps Optional dependency injection hooks (mainly for tests).
 * @returns Netsocket server adapter implementing the `NetsocketServer` port.
 */
export const createNetsocketServer = (
  deps: NetsocketServerDeps = {},
): NetsocketServer => {
  const context: NetsocketTransportContext = {
    nsEncoders: deps.nsEncoders ?? new WeakMap<NetSocket, Transform>(),
    nsPendingWrites: deps.nsPendingWrites ?? new WeakMap<NetSocket, Buffer[]>(),
    nsBackpressuredSockets:
      deps.nsBackpressuredSockets ?? new WeakSet<NetSocket>(),
    ingress: deps.ingress ?? new Map<Guid, NetSocket>(),
    egress: deps.egress ?? new Map<Guid, NetSocket>(),
  };

  return {
    setup(handlers, options) {
      setupNetsocketServer(context, handlers, options);
    },
    send(destinationNode, channel, type, message) {
      sendNetsocketSignal(context, destinationNode, channel, type, message);
    },
    getServersByMode(mode) {
      return mode === "ingress" ? context.ingress : context.egress;
    },
  };
};
