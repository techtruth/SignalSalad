// Media exchange server
//  Selective Forwarding Unit architecture
//  Controlled and instructed by connecting back to signaling server
//  Client browsers connect with WebRTC
//
import minimist from "minimist";
import * as os from "os";
import { MediaSignaling as MediaSignalingClass } from "./lib/mediaSignaling.ts";
import { SFU as SFUClass } from "./lib/sfuCore.ts";

const resolveMode = (value: unknown): "ingress" | "egress" => {
  if (value === "ingress" || value === "egress") {
    return value;
  }
  throw new Error(
    `Invalid media server mode '${String(value)}'. Expected 'ingress' or 'egress'.`,
  );
};

const argv = minimist(process.argv);
const mode = resolveMode(argv.mode);

const resolveSignalingPort = (value: string | undefined) => {
  if (!value) {
    return 1188;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(
      `Invalid SIGNALING_PORT '${value}'. Expected integer range 1-65535.`,
    );
  }
  return parsed;
};

const resolveAnnouncedIp = () => {
  const envValue = process.env.ANNOUNCED_IP;
  if (typeof envValue === "string" && envValue.trim().length) {
    return envValue.trim();
  }

  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return undefined;
};

const main = async () => {
  const signalingHost = (process.env.SIGNALING_HOST as string) || "127.0.0.1";
  const signalingPort = resolveSignalingPort(process.env.SIGNALING_PORT);
  const announcedIp = resolveAnnouncedIp();

  // Start WebRTC server
  const sfu = new SFUClass(mode, announcedIp);
  await sfu.initialize();

  // Start netsocket communications to signaling server
  const mediaSignaling = new MediaSignalingClass(sfu);
  mediaSignaling.connect(signalingPort, signalingHost);

  let shuttingDown = false;
  const handleShutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`Received ${signal}; unregistering media server before exit.`);
    try {
      await mediaSignaling.shutdown("server_shutdown", `signal=${signal}`);
    } catch (err) {
      console.error("Failed graceful shutdown", err);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void handleShutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void handleShutdown("SIGTERM");
  });
};

void main().catch((err) => {
  console.error("Failed to initialize media server", err);
  process.exit(1);
});
