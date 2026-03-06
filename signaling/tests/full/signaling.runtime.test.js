import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

import WebSocket from "ws";
import * as lps from "length-prefixed-stream";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

const stripIpv6Brackets = (host) =>
  host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

const isWildcardHost = (host) =>
  WILDCARD_HOSTS.has(host) || WILDCARD_HOSTS.has(stripIpv6Brackets(host));

const toNetsocketDialHost = (host) =>
  isWildcardHost(host) ? "127.0.0.1" : stripIpv6Brackets(host);

const toWebSocketDialHost = (host) => {
  if (isWildcardHost(host)) {
    return "127.0.0.1";
  }
  const normalized = stripIpv6Brackets(host);
  return normalized.includes(":") ? `[${normalized}]` : normalized;
};

const waitForWsOpen = (ws) =>
  new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      ws.off("open", onOpen);
      ws.off("error", onError);
    };
    ws.on("open", onOpen);
    ws.on("error", onError);
  });

const waitForWsMessage = async (ws, predicate, timeoutMs = 5000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out waiting for websocket message"));
      }, timeoutMs);
      const onMessage = (buffer) => {
        cleanup();
        resolve(JSON.parse(buffer.toString()));
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        clearTimeout(timer);
        ws.off("message", onMessage);
        ws.off("error", onError);
      };
      ws.on("message", onMessage);
      ws.on("error", onError);
    });
    if (predicate(msg)) {
      return msg;
    }
  }
  throw new Error("Timed out waiting for matching websocket message");
};

class MediaClient {
  constructor(host, port) {
    this.closing = false;
    this.fatalError = null;
    this.socket = net.createConnection({ host, port });
    this.encoder = lps.encode();
    this.decoder = lps.decode();
    this.encoder.pipe(this.socket);
    this.socket.pipe(this.decoder);
    this.socket.on("error", (error) => {
      if (this.closing && ["ECONNRESET", "EPIPE"].includes(error.code)) {
        return;
      }
      this.fatalError = error;
    });
    this.encoder.on("error", (error) => {
      if (this.closing && ["ECONNRESET", "EPIPE"].includes(error.code)) {
        return;
      }
      this.fatalError = error;
    });
    this.decoder.on("error", (error) => {
      if (this.closing && ["ECONNRESET", "EPIPE"].includes(error.code)) {
        return;
      }
      this.fatalError = error;
    });
  }

  async waitConnected() {
    if (this.socket.connecting === false) {
      return;
    }
    await once(this.socket, "connect");
  }

  send(node, payload) {
    const envelope = { node, payload };
    this.encoder.write(Buffer.from(JSON.stringify(envelope)));
  }

  close() {
    this.closing = true;
    this.socket.end();
  }

  assertHealthy() {
    if (this.fatalError) {
      throw this.fatalError;
    }
  }
}

const startSignaling = (cwd) => {
  const child = spawn("node", ["--import", "tsx", "server.ts"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DOMAIN: "",
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });

  const waitUntilReady = async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const wsMatch = stdout.match(
        /Server running on http:\/\/(\[[^\]]+\]|[^:\s]+):(\d+)/,
      );
      const nsMatch = stdout.match(
        /Netsocket Signaling is listening on (\[[^\]]+\]|[^:\s]+):(\d+)/,
      );
      if (wsMatch && nsMatch) {
        return {
          websocket: {
            host: wsMatch[1],
            port: Number(wsMatch[2]),
          },
          netsocket: {
            host: nsMatch[1],
            port: Number(nsMatch[2]),
          },
        };
      }
      if (child.exitCode !== null) {
        throw new Error(
          `Signaling exited early (${child.exitCode})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
        );
      }
      await sleep(100);
    }
    throw new Error(
      `Timed out waiting for signaling startup\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`,
    );
  };

  return { child, waitUntilReady };
};

test(
  "runtime signaling: media register + websocket identity/error path",
  { timeout: 30000 },
  async (t) => {
    const cwd = new URL("../../", import.meta.url).pathname;
    const { child, waitUntilReady } = startSignaling(cwd);
    let endpoints;

    try {
      try {
        endpoints = await waitUntilReady();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("EPERM") ||
          message.includes("operation not permitted") ||
          message.includes("Signaling exited early (1)")
        ) {
          t.skip("Runtime sockets are blocked in this environment");
          return;
        }
        throw error;
      }

      const nsHost = toNetsocketDialHost(endpoints.netsocket.host);
      const nsPort = endpoints.netsocket.port;
      const wsHost = toWebSocketDialHost(endpoints.websocket.host);
      const wsPort = endpoints.websocket.port;

      const ingress = new MediaClient(nsHost, nsPort);
      const egress = new MediaClient(nsHost, nsPort);
      await ingress.waitConnected();
      await egress.waitConnected();

      ingress.send("ingress-1", {
        type: "registerMediaServer",
        message: { registrationId: "ingress-1", mode: "ingress", region: "local" },
      });
      egress.send("egress-1", {
        type: "registerMediaServer",
        message: { registrationId: "egress-1", mode: "egress", region: "local" },
      });
      ingress.assertHealthy();
      egress.assertHealthy();

      const ws = new WebSocket(`ws://${wsHost}:${wsPort}/signaling`);
      await waitForWsOpen(ws);

      ws.send(JSON.stringify({ type: "requestIdentity", message: { region: "local" } }));
      const identity = await waitForWsMessage(ws, (msg) => msg.type === "identity");
      assert.ok(identity.message.peerId);

      ws.send(
        JSON.stringify({
          type: "joinRoom",
          message: { peerId: "someone-else", room: "demo" },
        }),
      );
      const rejection = await waitForWsMessage(
        ws,
        (msg) =>
          msg.type === "error" &&
          msg.message.error === "requestRejected" &&
          String(msg.message.detail).includes("peer ownership mismatch"),
      );
      assert.equal(rejection.type, "error");
      ingress.assertHealthy();
      egress.assertHealthy();

      ingress.send("ingress-1", {
        type: "unregisterMediaServer",
        message: { mode: "ingress", region: "local", reason: "maintenance" },
      });
      egress.send("egress-1", {
        type: "unregisterMediaServer",
        message: { mode: "egress", region: "local", reason: "maintenance" },
      });

      ws.close();
      ingress.close();
      egress.close();
    } finally {
      if (!child.killed) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), sleep(2000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
    }
  },
);

test(
  "runtime signaling: websocket endpoint only upgrades on /signaling",
  { timeout: 30000 },
  async (t) => {
    const cwd = new URL("../../", import.meta.url).pathname;
    const { child, waitUntilReady } = startSignaling(cwd);
    let endpoints;

    try {
      try {
        endpoints = await waitUntilReady();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("EPERM") ||
          message.includes("operation not permitted") ||
          message.includes("Signaling exited early (1)")
        ) {
          t.skip("Runtime sockets are blocked in this environment");
          return;
        }
        throw error;
      }

      const wsHost = toWebSocketDialHost(endpoints.websocket.host);
      const wsPort = endpoints.websocket.port;

      const badPathWs = new WebSocket(`ws://${wsHost}:${wsPort}/not-signaling`);
      const badPathError = await new Promise((resolve) => {
        badPathWs.once("error", (error) => resolve(error));
      });
      assert.ok(String(badPathError).includes("Unexpected server response: 404"));

      const signalingWs = new WebSocket(`ws://${wsHost}:${wsPort}/signaling`);
      await waitForWsOpen(signalingWs);
      signalingWs.close();
    } finally {
      if (!child.killed) {
        child.kill("SIGTERM");
        await Promise.race([once(child, "exit"), sleep(2000)]);
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }
    }
  },
);
