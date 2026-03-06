import Signaling from "./lib/signaling/signaling.ts";
import { createNetsocketServer } from "./lib/listeners/netsocketServer.ts";
import { createWebSocketServer } from "./lib/listeners/websocketServer.ts";

type SignalingStartupConfig = {
  secureWebSocket: boolean;
  domain: string | undefined;
  websocketPaths: string[];
  host: string;
  websocketPorts: {
    http: number;
    https: number;
  };
  websocketHeartbeatMs: number;
  netsocketPort: number;
};

const DEFAULT_WEBSOCKET_PATHS = ["/signaling", "/status"];
const DEFAULT_BIND_HOST = "0.0.0.0";
const DEFAULT_WEBSOCKET_HEARTBEAT_MS = 30_000;

const readPort = (envName: string, fallback: number) => {
  const value = process.env[envName];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(
      `${envName} must be a positive integer port number (received '${value}')`,
    );
  }
  return parsed;
};

const readPositiveInteger = (envName: string, fallback: number) => {
  const value = process.env[envName];
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new Error(
      `${envName} must be a positive integer (received '${value}')`,
    );
  }
  return parsed;
};

const resolveStartupConfig = (): SignalingStartupConfig => {
  const secureWebSocket = process.env.SIGNALING_SECURE_WEBSOCKET !== "false";
  return {
    secureWebSocket,
    domain: process.env.DOMAIN,
    websocketPaths: DEFAULT_WEBSOCKET_PATHS,
    host: process.env.SIGNALING_BIND_HOST || DEFAULT_BIND_HOST,
    websocketPorts: {
      http: readPort("SIGNALING_WS_HTTP_PORT", 8080),
      https: readPort("SIGNALING_WS_HTTPS_PORT", 8443),
    },
    websocketHeartbeatMs: readPositiveInteger(
      "SIGNALING_WS_HEARTBEAT_MS",
      DEFAULT_WEBSOCKET_HEARTBEAT_MS,
    ),
    netsocketPort: readPort("SIGNALING_NETSOCKET_PORT", 1188),
  };
};

const printStartupOverview = (config: SignalingStartupConfig) => {
  const secureMode = config.secureWebSocket ? "enabled" : "disabled";
  const domainLabel = config.domain ?? "(unset, self-signed fallback)";
  const websocketRoutes = config.websocketPaths.join(", ");

  console.log("SignalSalad signaling startup");
  console.log(`- WebSocket mode: ${secureMode}`);
  console.log(
    `- WebSocket listeners: ${config.host}:${config.websocketPorts.http} (http), ${config.host}:${config.websocketPorts.https} (https)`,
  );
  console.log(`- WebSocket heartbeat: ${config.websocketHeartbeatMs}ms`);
  console.log(`- WebSocket routes: ${websocketRoutes}`);
  console.log(
    `- Netsocket listener: ${config.host}:${config.netsocketPort} (tcp)`,
  );
  console.log(`- TLS domain: ${domainLabel}`);
  console.log(
    "- Runtime orchestration: websocket ingress -> request dispatch -> peer lifecycle/routing -> media-server relay",
  );
};

const config = resolveStartupConfig();
printStartupOverview(config);

// 1) Create listener servers (edge adapters).
const websocketServer = createWebSocketServer();
const netsocketServer = createNetsocketServer();

// 2) Create the orchestration core and inject both listener servers.
const signaling = new Signaling({
  websocketServer,
  netsocketServer,
});

// 3) Bind transport handlers in composition root.
const websocketHandlers = {
  onSignal: signaling.incomingWebsocketSignal.bind(signaling),
  onClose: signaling.onWebsocketClose.bind(signaling),
  onStatusSubscribe: signaling.onStatusSubscriberConnected.bind(signaling),
  onStatusUnsubscribe: signaling.onStatusSubscriberDisconnected.bind(signaling),
  onDiagnostic: signaling.onListenerDiagnostic.bind(signaling),
};
const netsocketHandlers = {
  onSignal: signaling.incomingNetsocketCommand.bind(signaling),
  onClose: signaling.onNetsocketClose.bind(signaling),
  onDiagnostic: signaling.onListenerDiagnostic.bind(signaling),
};

// 4) Activate listeners.
// WebRTC/RTP transport ports are opened by media servers after signaling
// commands; signaling itself exposes websocket + netsocket control planes.
websocketServer.setup(config.secureWebSocket, websocketHandlers, {
  host: config.host,
  httpPort: config.websocketPorts.http,
  httpsPort: config.websocketPorts.https,
  signalingPath: config.websocketPaths[0],
  statusPath: config.websocketPaths[1],
  domain: config.domain,
  heartbeatIntervalMs: config.websocketHeartbeatMs,
});
netsocketServer.setup(netsocketHandlers, {
  host: config.host,
  port: config.netsocketPort,
});
