/**
 * Websocket listener adapter for signaling.
 *
 * Responsibilities:
 * - expose HTTP/HTTPS upgrade endpoints for signaling + status channels,
 * - validate inbound websocket request payloads before dispatch,
 * - manage connection lifecycle bookkeeping and heartbeat liveness checks,
 * - provide typed outbound websocket delivery primitives for signaling.
 */
import type { IncomingMessage } from "http";
import type WebSocketType from "ws";

import type { Guid } from "../../../types/baseTypes.d.ts";
import type {
  RequestMessage,
  SystemDiagnosticEvent,
} from "../../../types/wsRelay.d.ts";
import type { TracePayload } from "../observability/trace.js";
import { traceWsFail, traceWsIn, traceWsOut } from "../observability/trace.js";
import {
  isUserRequestMessage,
  type WsMessageMap,
} from "../protocol/signalingIoValidation.js";
import { formatServerAddress } from "./serverAddress.js";

import uuid from "uuid4";
import express from "express";
import * as fs from "fs";
import * as http from "http";
import * as https from "https";
import * as path from "path";
import pem from "pem";
import type { Socket as NetSocket } from "net";
import { WebSocketServer as WsUpgradeServer } from "ws";

/** Logical websocket channel names supported by this adapter. */
export type WebSocketChannel = "signaling" | "status";
/**
 * Websocket connection shape enriched with runtime signaling metadata.
 *
 * `isAlive` is used by heartbeat probes to cull dead connections.
 */
export type IdentifiedWebSocket = WebSocketType & {
  id?: Guid;
  channel?: WebSocketChannel;
  isAlive?: boolean;
};

/**
 * Hooks provided by the signaling orchestration layer for websocket ingress/egress.
 */
export type WebSocketHandlers = {
  onSignal: (wsid: Guid, signal: RequestMessage) => void | Promise<void>;
  onClose: (wsid: Guid) => void;
  onStatusSubscribe?: (wsid: Guid) => void;
  onStatusUnsubscribe?: (wsid: Guid) => void;
  onDiagnostic?: (event: Omit<SystemDiagnosticEvent, "at">) => void;
};

/** Mutable websocket client/subscriber indexes owned by the adapter. */
export type WebSocketTransportContext = {
  wsClients: Map<Guid, IdentifiedWebSocket>;
  statusSubscribers: Set<Guid>;
};

/** Optional websocket bind/path/heartbeat overrides. */
export type WebSocketServerOptions = {
  host?: string;
  httpPort?: number;
  httpsPort?: number;
  signalingPath?: string;
  statusPath?: string;
  domain?: string;
  heartbeatIntervalMs?: number;
};

const DEFAULT_WEBSOCKET_HOST = "0.0.0.0";
const DEFAULT_WEBSOCKET_HTTP_PORT = 8080;
const DEFAULT_WEBSOCKET_HTTPS_PORT = 8443;
const DEFAULT_SIGNALING_PATH = "/signaling";
const DEFAULT_STATUS_PATH = "/status";
const ACME_CHALLENGE_WEBROOT = "public/.well-known/acme-challenge";
const DEFAULT_WEBSOCKET_HEARTBEAT_MS = 30_000;
const DOCS_WEBROOT = "public/docs";
const GENERATED_DOCS_WEBROOT = path.join(DOCS_WEBROOT, "generated");

/**
 * Parses and validates heartbeat interval from environment configuration.
 *
 * @param value Raw `SIGNALING_WS_HEARTBEAT_MS` value.
 * @returns Parsed heartbeat interval in milliseconds.
 * @throws {Error} When the configured value is not a positive integer.
 */
const resolveHeartbeatIntervalMs = (value: string | undefined) => {
  if (!value || value.trim().length === 0) {
    return DEFAULT_WEBSOCKET_HEARTBEAT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid SIGNALING_WS_HEARTBEAT_MS value '${value}'. Expected a positive integer.`,
    );
  }
  return parsed;
};

/**
 * Adapter interface for websocket server lifecycle + delivery.
 *
 * The signaling orchestration layer depends on this interface rather than
 * directly owning websocket connection maps.
 */
export type WebSocketServer = {
  /** Boots websocket listeners and wires signaling/status handlers. */
  setup(
    secure: boolean,
    handlers: WebSocketHandlers,
    options?: WebSocketServerOptions,
  ): void;
  /** Sends one typed websocket message to `wsid`. */
  send<T extends keyof WsMessageMap>(
    wsid: Guid,
    type: T,
    message: WsMessageMap[T],
  ): void;
  /** Closes websocket connection by id using provided close code. */
  close(wsid: Guid, code: number): void;
  /** Removes websocket bookkeeping for one connection id. */
  pruneConnection(wsid: Guid): {
    hadClient: boolean;
    wasStatusSubscriber: boolean;
  };
  /** Returns mutable map of active websocket clients. */
  getClients(): Map<Guid, IdentifiedWebSocket>;
  /** Returns mutable set of status-subscriber websocket ids. */
  getStatusSubscribers(): Set<Guid>;
  /** Returns current count of status subscribers. */
  getStatusSubscriberCount(): number;
};

/** Optional dependency injection hooks for tests/custom adapters. */
export type WebSocketServerDeps = Partial<WebSocketTransportContext>;

/**
 * Resolves websocket route and assigns channel semantics.
 *
 * Query strings/fragments are ignored so channel mapping is path-only.
 *
 * @param request Incoming HTTP upgrade request.
 * @returns Normalized request path or `undefined` when invalid.
 */
const resolveWebSocketPath = (request: IncomingMessage) => {
  const rawUrl = request.url;
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return undefined;
  }

  const fragmentIndex = rawUrl.indexOf("#");
  const urlWithoutFragment =
    fragmentIndex === -1 ? rawUrl : rawUrl.slice(0, fragmentIndex);

  const queryIndex = urlWithoutFragment.indexOf("?");
  const pathname =
    queryIndex === -1
      ? urlWithoutFragment
      : urlWithoutFragment.slice(0, queryIndex);

  if (!pathname.startsWith("/")) {
    return undefined;
  }

  return pathname;
};

/** Maps parsed request path to signaling/status channel semantics. */
const resolveWebSocketChannel = (
  request: IncomingMessage,
  paths: { signalingPath: string; statusPath: string },
): WebSocketChannel | undefined => {
  const pathname = resolveWebSocketPath(request);
  if (!pathname) {
    return undefined;
  }
  if (pathname === paths.signalingPath) {
    return "signaling";
  }
  if (pathname === paths.statusPath) {
    return "status";
  }
  return undefined;
};

/**
 * Attaches websocket upgrade handling to an HTTP(S) server with strict path allow-listing.
 *
 * Non-whitelisted upgrade targets are immediately rejected with HTTP 404.
 *
 * @param server HTTP(S) server handling websocket upgrades.
 * @param upgradeServer Websocket upgrade server instance.
 * @param paths Allowed signaling/status websocket paths.
 */
const wireWebSocketUpgradeServer = (
  server: http.Server | https.Server,
  upgradeServer: WsUpgradeServer,
  paths: { signalingPath: string; statusPath: string },
) => {
  server.on(
    "upgrade",
    (request: IncomingMessage, socket: NetSocket, head: Buffer) => {
      if (!resolveWebSocketChannel(request, paths)) {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        if (typeof socket.destroy === "function") {
          socket.destroy();
        }
        return;
      }
      upgradeServer.handleUpgrade(
        request,
        socket,
        head,
        (ws: WebSocketType) => {
          upgradeServer.emit("connection", ws, request);
        },
      );
    },
  );
};

/**
 * Boots websocket listeners for both user signaling and status subscriptions.
 *
 * This wiring also owns heartbeat checks and close/error cleanup that keep
 * websocket indexes in sync with signaling session state.
 *
 * @param context Mutable websocket transport indexes.
 * @param secure Whether to also start HTTPS websocket listener.
 * @param handlers Signaling lifecycle handlers.
 * @param options Optional bind/path/heartbeat overrides.
 */
export const setupWebSocketServer = (
  context: WebSocketTransportContext,
  secure: boolean,
  handlers: WebSocketHandlers,
  options: WebSocketServerOptions = {},
) => {
  const host = options.host ?? DEFAULT_WEBSOCKET_HOST;
  const httpPort = options.httpPort ?? DEFAULT_WEBSOCKET_HTTP_PORT;
  const httpsPort = options.httpsPort ?? DEFAULT_WEBSOCKET_HTTPS_PORT;
  const signalingPath = options.signalingPath ?? DEFAULT_SIGNALING_PATH;
  const statusPath = options.statusPath ?? DEFAULT_STATUS_PATH;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    resolveHeartbeatIntervalMs(process.env.SIGNALING_WS_HEARTBEAT_MS);
  const paths = { signalingPath, statusPath };
  const upgradeServer = new WsUpgradeServer({
    noServer: true,
    clientTracking: false,
    maxPayload: 8192,
  });

  upgradeServer.on(
    "connection",
    (relay: WebSocketType, request: IncomingMessage) => {
      const relayWithId = relay as IdentifiedWebSocket;
      const channel = resolveWebSocketChannel(request, paths);
      if (!channel) {
        relay.close(1008, "unsupported websocket path");
        return;
      }
      relayWithId.id = uuid();
      relayWithId.channel = channel;
      relayWithId.isAlive = true;
      context.wsClients.set(relayWithId.id as Guid, relayWithId);
      relay.on("pong", () => {
        relayWithId.isAlive = true;
      });
      relay.on("error", (err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        traceWsFail(relayWithId.id as Guid, "transport_error", errorMessage);
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "websocketRequest",
          message: "websocket transport error",
          details: errorMessage,
          context: {
            wsid: relayWithId.id as Guid,
            channel: relayWithId.channel ?? "unknown",
          },
        });
        console.error("WebSocket transport error", {
          wsid: relayWithId.id,
          channel: relayWithId.channel,
          error: errorMessage,
        });
        if (relay.readyState === 0 || relay.readyState === 1) {
          relay.close(1011, "websocket transport error");
        }
      });

      if (channel === "status") {
        context.statusSubscribers.add(relayWithId.id as Guid);
        try {
          handlers.onStatusSubscribe?.(relayWithId.id as Guid);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          handlers.onDiagnostic?.({
            severity: "warn",
            category: "websocketRequest",
            message: "status subscribe handler failed",
            details: errorMessage,
            context: {
              wsid: relayWithId.id as Guid,
            },
          });
          console.error("Status subscribe handler failed", {
            wsid: relayWithId.id,
            error: errorMessage,
          });
          relay.close(1011, "status subscribe handler failure");
          return;
        }
      }

      relay.on("message", (messagebuffer: WebSocketType.RawData) => {
        if (relayWithId.channel === "status") {
          return;
        }
        let parsedMessage: unknown;
        try {
          parsedMessage = JSON.parse(messagebuffer.toString());
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          traceWsFail(
            relayWithId.id as Guid,
            "invalid_json_payload",
            errorMessage,
          );
          handlers.onDiagnostic?.({
            severity: "warn",
            category: "websocketRequest",
            message: "invalid websocket JSON payload",
            details: errorMessage,
            context: {
              wsid: relayWithId.id as Guid,
              channel: relayWithId.channel ?? "unknown",
            },
          });
          console.error("Invalid websocket JSON payload", err);
          relay.close(1003, "invalid websocket payload");
          return;
        }
        if (!isUserRequestMessage(parsedMessage)) {
          traceWsFail(
            relayWithId.id as Guid,
            "invalid_message_shape",
            "payload failed websocket request schema validation",
          );
          handlers.onDiagnostic?.({
            severity: "warn",
            category: "websocketRequest",
            message: "invalid websocket message shape",
            details: "payload failed websocket request schema validation",
            context: {
              wsid: relayWithId.id as Guid,
              channel: relayWithId.channel ?? "unknown",
            },
          });
          console.error("Invalid websocket message shape", {
            wsid: relayWithId.id,
            payload: parsedMessage,
          });
          relay.close(1003, "invalid websocket message");
          return;
        }
        const message = parsedMessage;
        try {
          traceWsIn(relayWithId.id as Guid, message as unknown as TracePayload);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          traceWsFail(
            relayWithId.id as Guid,
            "trace_ingest_failed",
            errorMessage,
          );
          handlers.onDiagnostic?.({
            severity: "warn",
            category: "websocketRequest",
            message: "websocket trace ingest failed",
            details: errorMessage,
            context: {
              wsid: relayWithId.id as Guid,
              messageType: message.type,
            },
          });
          console.error("WebSocket trace ingest failed", {
            wsid: relayWithId.id,
            messageType: message.type,
            error: errorMessage,
          });
          relay.close(1011, "websocket trace failure");
          return;
        }
        Promise.resolve(
          handlers.onSignal(relayWithId.id as Guid, message),
        ).catch((err: unknown) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          traceWsFail(
            relayWithId.id as Guid,
            "signal_handler_failed",
            `messageType=${message.type}, error=${errorMessage}`,
          );
          handlers.onDiagnostic?.({
            severity: "warn",
            category: "websocketRequest",
            message: "websocket signal handler failed",
            details: errorMessage,
            context: {
              wsid: relayWithId.id as Guid,
              messageType: message.type,
            },
          });
          console.error("WebSocket signal handler failed", {
            wsid: relayWithId.id,
            error: errorMessage,
            messageType: message.type,
          });
          if (relay.readyState === 1) {
            relay.close(1011, "signal handler failure");
          }
        });
      });

      relay.on("close", (code: number, reason: Buffer) => {
        console.log(
          `Signaling transport closed to ${
            relayWithId.id
          } with code ${code} ${reason.toString()}`,
        );

        context.wsClients.delete(relayWithId.id as Guid);
        try {
          if (relayWithId.channel === "status") {
            context.statusSubscribers.delete(relayWithId.id as Guid);
            handlers.onStatusUnsubscribe?.(relayWithId.id as Guid);
          } else {
            handlers.onClose(relayWithId.id as Guid);
          }
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          traceWsFail(
            relayWithId.id as Guid,
            "close_handler_failed",
            errorMessage,
          );
          handlers.onDiagnostic?.({
            severity: "warn",
            category: "websocketRequest",
            message: "websocket close handler failed",
            details: errorMessage,
            context: {
              wsid: relayWithId.id as Guid,
              channel: relayWithId.channel ?? "unknown",
            },
          });
          console.error("WebSocket close handler failed", {
            wsid: relayWithId.id,
            channel: relayWithId.channel,
            error: errorMessage,
          });
        }
      });
    },
  );

  setInterval(() => {
    for (const relay of context.wsClients.values()) {
      if (relay.readyState !== 1) {
        continue;
      }
      if (relay.isAlive === false) {
        traceWsFail(
          relay.id as Guid,
          "heartbeat_timeout",
          `channel=${relay.channel ?? "unknown"}`,
        );
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "websocketRequest",
          message: "websocket heartbeat timeout; terminating socket",
          details: `channel=${relay.channel ?? "unknown"}`,
          context: {
            wsid: relay.id as Guid,
            channel: relay.channel ?? "unknown",
          },
        });
        relay.terminate();
        continue;
      }
      relay.isAlive = false;
      try {
        relay.ping();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        traceWsFail(relay.id as Guid, "heartbeat_ping_failed", errorMessage);
        handlers.onDiagnostic?.({
          severity: "warn",
          category: "websocketRequest",
          message: "websocket heartbeat ping failed",
          details: errorMessage,
          context: {
            wsid: relay.id as Guid,
            channel: relay.channel ?? "unknown",
          },
        });
        relay.terminate();
      }
    }
  }, heartbeatIntervalMs);

  const app = express();
  // Keep runtime docs URLs clean while storing generated API docs under
  // `public/docs/generated/*`.
  app.use(
    "/docs/signaling",
    express.static(path.join(GENERATED_DOCS_WEBROOT, "signaling")),
  );
  app.use(
    "/docs/mediaserver",
    express.static(path.join(GENERATED_DOCS_WEBROOT, "mediaserver")),
  );
  app.use(
    "/docs/harness",
    express.static(path.join(GENERATED_DOCS_WEBROOT, "harness")),
  );
  app.use(
    "/docs/demo-ui",
    express.static(path.join(GENERATED_DOCS_WEBROOT, "demo-ui")),
  );
  app.use(/^\/docs\/media(?:\/.*)?$/, (_req, res) => {
    res.status(404).send("Not Found. Use /docs/mediaserver.");
  });
  app.get("/docs", (_req, res) => {
    res.redirect("/docs/README.md");
  });
  app.get("/docs/", (_req, res) => {
    res.redirect("/docs/README.md");
  });
  // Serves markdown docs and any other static docs assets when
  // `public/docs` exists; otherwise requests naturally fall through.
  app.use("/docs", express.static(DOCS_WEBROOT));
  app.use(
    "/.well-known/acme-challenge",
    express.static(ACME_CHALLENGE_WEBROOT),
  );
  app.use(express.static("public", { dotfiles: "allow" }));
  app.use(
    (
      err: unknown,
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const maybeErr = err as NodeJS.ErrnoException | undefined;
      if (maybeErr?.code === "EACCES") {
        res.status(404).end();
        return;
      }
      next(err);
    },
  );

  const insecureServer = http.createServer(app);
  wireWebSocketUpgradeServer(insecureServer, upgradeServer, paths);
  insecureServer.listen(httpPort, host, () => {
    const address = insecureServer.address();
    console.log(`Server running on http://${formatServerAddress(address)}`);
  });

  if (!secure) {
    return;
  }

  const envDomain = options.domain ?? process.env.DOMAIN;
  const certPath = envDomain
    ? `/etc/letsencrypt/live/${envDomain}/fullchain.pem`
    : undefined;
  const keyPath = envDomain
    ? `/etc/letsencrypt/live/${envDomain}/privkey.pem`
    : undefined;
  const hasFiles =
    certPath && keyPath && fs.existsSync(certPath) && fs.existsSync(keyPath);

  const startSecureServer = (options: { key: string; cert: string }) => {
    const secureServer = https.createServer(options, app);
    wireWebSocketUpgradeServer(secureServer, upgradeServer, paths);
    secureServer.listen(httpsPort, host, () => {
      const address = secureServer.address();
      console.log(`Server running on https://${formatServerAddress(address)}`);
    });
  };

  if (hasFiles) {
    startSecureServer({
      key: fs.readFileSync(keyPath as string, "utf8"),
      cert: fs.readFileSync(certPath as string, "utf8"),
    });
    return;
  }

  pem.createCertificate(
    { days: 1, selfSigned: true },
    (err: Error | null, keys: { serviceKey: string; certificate: string }) => {
      if (err) {
        throw err;
      }
      startSecureServer({
        key: keys.serviceKey,
        cert: keys.certificate,
      });
    },
  );
};

/**
 * Sends a typed websocket message to a connected browser session.
 *
 * Missing/non-open clients are treated as hard failures. On synchronous send
 * errors, the socket is closed best-effort and the caller receives a detailed
 * error with close-failure context when available.
 *
 * @param wsClients Active websocket client map.
 * @param wsid Destination websocket id.
 * @param type Outbound websocket message type.
 * @param message Typed websocket payload.
 * @throws {Error} When destination is missing/not open or send fails.
 */
export const sendWebSocketSignal = <T extends keyof WsMessageMap>(
  wsClients: Map<Guid, IdentifiedWebSocket>,
  wsid: Guid,
  type: T,
  message: WsMessageMap[T],
) => {
  const client = wsClients.get(wsid);
  if (!client) {
    traceWsFail(wsid, "send_missing_client");
    throw new Error(`WebSocket client missing for send ${wsid}`);
  }
  const readyState = (client as { readyState?: number }).readyState;
  if (typeof readyState === "number" && readyState !== 1) {
    traceWsFail(wsid, "send_not_open", `state=${readyState}`);
    throw new Error(
      `WebSocket client not open for send ${wsid} (state=${readyState})`,
    );
  }
  const reply = { type, message };
  try {
    traceWsOut(wsid, reply as unknown as TracePayload);
  } catch (error) {
    console.warn("WebSocket outbound trace failed", {
      wsid,
      messageType: type,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    client.send(JSON.stringify(reply));
  } catch (error) {
    const currentReadyState = (client as { readyState?: number }).readyState;
    let closeFailureMessage: string | undefined;
    try {
      if (currentReadyState === 0 || currentReadyState === 1) {
        client.close(1011, "websocket send failed");
      }
    } catch (closeError) {
      closeFailureMessage =
        closeError instanceof Error ? closeError.message : String(closeError);
      console.warn("WebSocket close after send failure failed", {
        wsid,
        messageType: type,
        error: closeFailureMessage,
      });
    }
    const sendFailureMessage =
      error instanceof Error ? error.message : String(error);
    traceWsFail(
      wsid,
      "send_failed",
      closeFailureMessage
        ? `${sendFailureMessage}; close=${closeFailureMessage}`
        : sendFailureMessage,
    );
    throw new Error(
      closeFailureMessage
        ? `WebSocket client send failed for ${wsid}: ${sendFailureMessage}; close failed: ${closeFailureMessage}`
        : `WebSocket client send failed for ${wsid}: ${sendFailureMessage}`,
    );
  }
};

/**
 * Creates a websocket transport adapter with isolated in-memory connection
 * state for active clients and status subscribers.
 *
 * @param deps Optional dependency injection hooks (mostly for tests).
 * @returns Websocket server adapter implementing the `WebSocketServer` port.
 */
export const createWebSocketServer = (
  deps: WebSocketServerDeps = {},
): WebSocketServer => {
  const context: WebSocketTransportContext = {
    wsClients: deps.wsClients ?? new Map<Guid, IdentifiedWebSocket>(),
    statusSubscribers: deps.statusSubscribers ?? new Set<Guid>(),
  };

  return {
    setup(secure, handlers, options) {
      setupWebSocketServer(context, secure, handlers, options);
    },
    send(wsid, type, message) {
      sendWebSocketSignal(context.wsClients, wsid, type, message);
    },
    close(wsid, code) {
      const socket = context.wsClients.get(wsid);
      if (!socket) {
        throw new Error(
          `disconnectPeerWebsocket blocked: wsid=${wsid}, reason=websocket not found`,
        );
      }
      socket.close(code);
    },
    pruneConnection(wsid) {
      const hadClient = context.wsClients.delete(wsid);
      const wasStatusSubscriber = context.statusSubscribers.delete(wsid);
      return {
        hadClient,
        wasStatusSubscriber,
      };
    },
    getClients() {
      return context.wsClients;
    },
    getStatusSubscribers() {
      return context.statusSubscribers;
    },
    getStatusSubscriberCount() {
      return context.statusSubscribers.size;
    },
  };
};
