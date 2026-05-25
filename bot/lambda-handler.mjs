import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const botScriptPath = path.join(__dirname, "bot.mjs");

const asTrimmedString = (value, fallback = "") => {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
};

const asPositiveIntegerString = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return String(parsed);
};

const asNonNegativeIntegerString = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return String(parsed);
};

const buildBotEnv = (event) => {
  const payload = event && typeof event === "object" ? event : {};

  return {
    ...process.env,
    BOT_APP_URL: asTrimmedString(payload.appUrl, process.env.BOT_APP_URL || ""),
    BOT_ROOM: asTrimmedString(payload.room, process.env.BOT_ROOM || "demo"),
    BOT_REGION: asTrimmedString(payload.botRegion, process.env.BOT_REGION || ""),
    BOT_INDEX: asPositiveIntegerString(payload.botIndex, process.env.BOT_INDEX || "1"),
    BOT_COUNT: asPositiveIntegerString(payload.botCount, process.env.BOT_COUNT || "1"),
    BOT_LOG_DIR: asTrimmedString(process.env.BOT_LOG_DIR, "/tmp/bot-logs"),
    BOT_START_DELAY_MS: asNonNegativeIntegerString(
      payload.startDelayMs,
      process.env.BOT_START_DELAY_MS || "0",
    ),
    BOT_START_STAGGER_MS: "0",
    BOT_START_STAGGER_RESET_MS: asNonNegativeIntegerString(
      process.env.BOT_START_STAGGER_RESET_MS,
      "120000",
    ),
    BOT_ROOM_EGRESS_READY_TIMEOUT_MS: asNonNegativeIntegerString(
      process.env.BOT_ROOM_EGRESS_READY_TIMEOUT_MS,
      "90000",
    ),
    BOT_MEDIA_ENABLE_TIMEOUT_MS: asNonNegativeIntegerString(
      process.env.BOT_MEDIA_ENABLE_TIMEOUT_MS,
      "90000",
    ),
  };
};

const runBot = async (event) => {
  const childEnv = buildBotEnv(event);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [botScriptPath], {
      cwd: __dirname,
      env: childEnv,
      stdio: "inherit",
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({
          ok: true,
          exitCode: 0,
          signal: signal ?? null,
        });
        return;
      }
      reject(
        new Error(
          `Bot process exited unsuccessfully (code=${code ?? "null"}, signal=${signal ?? "null"})`,
        ),
      );
    });
  });
};

export const handler = async (event) => {
  const result = await runBot(event);
  return {
    status: "ok",
    ...result,
  };
};
