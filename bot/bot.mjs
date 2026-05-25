import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const env = process.env;
const hostname = env.HOSTNAME || "bot";
const logDir = env.BOT_LOG_DIR || "/bot/logs";
const appUrlBase = env.BOT_APP_URL || "https://signaling.local:8443";
const configuredRegion = (env.BOT_REGION || "").trim();
const buildAppUrl = () => {
  try {
    const url = new URL(appUrlBase);
    url.pathname = url.pathname.replace(/\/?$/, "/");
    url.searchParams.set("demoModal", "0");
    if (configuredRegion.length > 0) {
      url.searchParams.set("region", configuredRegion);
    }
    return url.toString();
  } catch {
    const base = appUrlBase.replace(/\/$/, "");
    const regionQuery =
      configuredRegion.length > 0
        ? `&region=${encodeURIComponent(configuredRegion)}`
        : "";
    return `${base}/?demoModal=0${regionQuery}`;
  }
};
const appUrl = buildAppUrl();
const slowStartMs = Number.parseInt(env.BOT_START_DELAY_MS || "0", 10);
const roomEgressReadyTimeoutMs = Number.parseInt(
  env.BOT_ROOM_EGRESS_READY_TIMEOUT_MS || "90000",
  10,
);
const mediaEnableTimeoutMs = Number.parseInt(
  env.BOT_MEDIA_ENABLE_TIMEOUT_MS || "90000",
  10,
);
const startStaggerMs = Number.parseInt(env.BOT_START_STAGGER_MS || "0", 10);
const startStaggerResetMs = Number.parseInt(
  env.BOT_START_STAGGER_RESET_MS || "120000",
  10,
);
const startStaggerStateDir =
  env.BOT_START_STAGGER_STATE_DIR || path.join(logDir, ".startup-stagger");

const parsePositiveInteger = (value) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return undefined;
  }
  return parsed;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseBooleanEnv = (value, fallback = false) => {
  if (typeof value !== "string") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
};

const resolveChromiumExecutablePath = () => {
  const candidates = [
    env.PUPPETEER_EXECUTABLE_PATH,
    "/usr/lib/chromium/chromium",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => typeof candidate === "string" && candidate.trim().length > 0);

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next candidate.
    }
  }

  return env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium";
};

const acquireFileLock = async (lockPath) => {
  const lockWaitTimeoutMs = 30000;
  const staleLockMs = 60000;
  const startedAtMs = Date.now();
  while (true) {
    try {
      return await fs.promises.open(lockPath, "wx");
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }
      try {
        const stat = await fs.promises.stat(lockPath);
        if (Date.now() - stat.mtimeMs > staleLockMs) {
          await fs.promises.unlink(lockPath);
          continue;
        }
      } catch {
        // Lock may have been removed by another process between stat/unlink.
      }
      if (Date.now() - startedAtMs > lockWaitTimeoutMs) {
        throw new Error(`Timed out waiting for startup lock: ${lockPath}`);
      }
      await sleep(100);
    }
  }
};

const resolveSharedBotIndex = async () => {
  await fs.promises.mkdir(startStaggerStateDir, { recursive: true });
  const lockPath = path.join(startStaggerStateDir, "index.lock");
  const statePath = path.join(startStaggerStateDir, "index-state.json");
  const lockHandle = await acquireFileLock(lockPath);

  let index = 1;
  try {
    const nowMs = Date.now();
    let state = { nextIndex: 1, lastAssignedAtMs: 0 };
    try {
      const raw = await fs.promises.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      state = {
        nextIndex: Number.isFinite(parsed?.nextIndex)
          ? parsed.nextIndex
          : 1,
        lastAssignedAtMs: Number.isFinite(parsed?.lastAssignedAtMs)
          ? parsed.lastAssignedAtMs
          : 0,
      };
    } catch {
      // First startup or corrupt state; start from index 1.
    }

    if (
      !Number.isFinite(state.lastAssignedAtMs) ||
      nowMs - state.lastAssignedAtMs > startStaggerResetMs
    ) {
      state.nextIndex = 1;
    }

    index = Math.max(1, Math.floor(state.nextIndex));
    const nextState = {
      nextIndex: index + 1,
      lastAssignedAtMs: nowMs,
    };
    await fs.promises.writeFile(
      statePath,
      `${JSON.stringify(nextState)}\n`,
      "utf8",
    );
  } finally {
    await lockHandle.close();
    await fs.promises.unlink(lockPath).catch(() => {});
  }

  return index;
};

const resolveBotIdentity = async () => {
  const explicitIndex = parsePositiveInteger(env.BOT_INDEX);
  if (explicitIndex) {
    return { botIndex: explicitIndex, source: "env" };
  }

  const hostnameSuffix = hostname.match(/-(\d+)$/);
  const hostnameIndex = parsePositiveInteger(hostnameSuffix?.[1]);
  if (hostnameIndex) {
    return { botIndex: hostnameIndex, source: "hostname" };
  }

  const allocatedIndex = await resolveSharedBotIndex();
  return { botIndex: allocatedIndex, source: "shared-state" };
};

const { botIndex, source: botIndexSource } = await resolveBotIdentity();
const roomPrefix = (env.BOT_ROOM_PREFIX || "").trim();
const explicitRoom = (env.BOT_ROOM || "").trim();
const room = explicitRoom || (roomPrefix ? `${roomPrefix}-${botIndex}` : "demo");
const puppeteerDumpio = parseBooleanEnv(env.PUPPETEER_DUMPIO, true);
const chromiumStderrLogging = parseBooleanEnv(env.PUPPETEER_CHROMIUM_STDERR, true);
const chromiumExecutablePath = resolveChromiumExecutablePath();
const chromiumUserDataDir = `/tmp/chromium-user-data-${process.pid}-${Date.now()}`;

const runId = new Date().toISOString().replace(/[:.]/g, "-");
const safeHostname = hostname.replace(/[^a-zA-Z0-9_.-]/g, "_");
const logFileName = `bot-${botIndex}-${safeHostname}-${runId}.jsonl`;
const logPath = path.join(logDir, logFileName);

fs.mkdirSync(logDir, { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: "a" });

const normalizeError = (value) => {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }
  if (typeof value === "string") {
    return { message: value };
  }
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return { message: String(value) };
  }
};

const writeLog = (level, event, details = {}) => {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    bot: {
      index: botIndex,
      hostname,
      room,
      region: configuredRegion || undefined,
      appUrl,
      pid: process.pid,
    },
    ...details,
  };
  const line = JSON.stringify(payload);
  if (!logStream.writableEnded) {
    logStream.write(`${line}\n`);
  }
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
};

const clickByText = async (page, selector, expectedText) => {
  await page.waitForFunction(
    (sel, text) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      return nodes.some((n) => n.textContent?.trim() === text && !n.disabled);
    },
    {},
    selector,
    expectedText,
  );
  const ok = await page.evaluate(
    (sel, text) => {
      const nodes = Array.from(document.querySelectorAll(sel));
      const target = nodes.find((n) => n.textContent?.trim() === text && !n.disabled);
      if (!target) return false;
      target.click();
      return true;
    },
    selector,
    expectedText,
  );
  if (!ok) {
    throw new Error(`Could not click ${expectedText}`);
  }
  writeLog("info", "ui_click", { selector, expectedText });
};

const installSignalingProbe = async (page) => {
  await page.evaluateOnNewDocument(() => {
    const state = {
      roomAttached: false,
      roomEgressReady: false,
      attachedRoom: null,
      lastSignalType: null,
    };
    window.__botSignalingState = state;

    const NativeWebSocket = window.WebSocket;
    class BotWebSocket extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            return;
          }
          try {
            const signal = JSON.parse(event.data);
            if (!signal || typeof signal.type !== "string") {
              return;
            }
            state.lastSignalType = signal.type;
            if (signal.type === "roomAttached") {
              state.roomAttached = true;
              const roomName = signal?.message?.room;
              if (typeof roomName === "string" && roomName.trim().length > 0) {
                state.attachedRoom = roomName;
              }
              return;
            }
            if (signal.type === "roomEgressReady") {
              const roomName = signal?.message?.room;
              if (!state.attachedRoom || !roomName || roomName === state.attachedRoom) {
                state.roomEgressReady = true;
              }
            }
          } catch {
            // Ignore non-signaling websocket messages.
          }
        });
      }
    }

    window.WebSocket = BotWebSocket;
  });
  writeLog("info", "signaling_probe_installed");
};

const waitForRoomAttached = async (page) => {
  await page.waitForFunction(() => {
    const joinButton = document.querySelector(".room-toggle");
    return (
      joinButton &&
      joinButton instanceof HTMLButtonElement &&
      joinButton.textContent?.trim() === "Leave Room"
    );
  });
  writeLog("info", "room_attached");
};

const waitForUplinkControlsEnabled = async (page) => {
  await page.waitForFunction(() => {
    const controls = Array.from(
      document.querySelectorAll(".media-status-panel .status-toggle"),
    );
    return (
      controls.length >= 2 &&
      controls.every(
        (control) =>
          control instanceof HTMLButtonElement && control.disabled === false,
      )
    );
  });
  writeLog("info", "uplink_controls_enabled");
};

const waitForRoomEgressReady = async (page) => {
  await page.waitForFunction(
    () => Boolean(window.__botSignalingState?.roomEgressReady === true),
    { timeout: roomEgressReadyTimeoutMs },
  );
  const snapshot = await page.evaluate(() => ({
    roomAttached: window.__botSignalingState?.roomAttached ?? false,
    roomEgressReady: window.__botSignalingState?.roomEgressReady ?? false,
    attachedRoom: window.__botSignalingState?.attachedRoom ?? null,
    lastSignalType: window.__botSignalingState?.lastSignalType ?? null,
  }));
  writeLog("info", "room_egress_ready", {
    timeoutMs: roomEgressReadyTimeoutMs,
    signalState: snapshot,
  });
};

const clickStatusToggle = async (page, kind) => {
  const normalizedKind = kind.toLowerCase();
  await page.waitForFunction(
    (targetKind) => {
      const controls = Array.from(
        document.querySelectorAll(".media-status-panel .status-toggle"),
      );
      return controls.some(
        (control) =>
          control instanceof HTMLButtonElement &&
          control.disabled === false &&
          control.textContent?.trim().toLowerCase().startsWith(targetKind),
      );
    },
    {},
    normalizedKind,
  );
  const clicked = await page.evaluate((targetKind) => {
    const controls = Array.from(
      document.querySelectorAll(".media-status-panel .status-toggle"),
    );
    const target = controls.find(
      (control) =>
        control instanceof HTMLButtonElement &&
        control.disabled === false &&
        control.textContent?.trim().toLowerCase().startsWith(targetKind),
    );
    if (!(target instanceof HTMLButtonElement)) {
      return null;
    }
    const buttonText = target.textContent?.trim() || "";
    target.click();
    return { buttonText };
  }, normalizedKind);
  if (!clicked) {
    throw new Error(`Could not click ${kind} toggle`);
  }
  writeLog("info", "ui_click", {
    selector: ".media-status-panel .status-toggle",
    expectedText: kind,
    actualButtonText: clicked.buttonText,
  });
};

const mediaRowIsActive = async (page, kind) => {
  const normalizedKind = kind.toLowerCase();
  return page.evaluate((targetKind) => {
    const rows = Array.from(
      document.querySelectorAll(".media-status-panel .status-row"),
    );
    const row = rows.find((candidateRow) => {
      const button = candidateRow.querySelector(".status-toggle");
      return (
        button &&
        button instanceof HTMLButtonElement &&
        button.textContent?.trim().toLowerCase().startsWith(targetKind)
      );
    });
    if (!row) {
      return false;
    }
    const activeDots = row.querySelectorAll(".status-dot.on");
    return activeDots.length >= 2;
  }, normalizedKind);
};

const waitForMediaEnabled = async (page, kind, timeoutMs = mediaEnableTimeoutMs) => {
  const normalizedKind = kind.toLowerCase();
  await page.waitForFunction(
    (targetKind) => {
      const rows = Array.from(
        document.querySelectorAll(".media-status-panel .status-row"),
      );
      const row = rows.find((candidateRow) => {
        const button = candidateRow.querySelector(".status-toggle");
        return (
          button &&
          button instanceof HTMLButtonElement &&
          button.textContent?.trim().toLowerCase().startsWith(targetKind)
        );
      });
      if (!row) {
        return false;
      }
      const activeDots = row.querySelectorAll(".status-dot.on");
      return activeDots.length >= 2;
    },
    { timeout: timeoutMs },
    normalizedKind,
  );
  writeLog("info", "local_media_enabled", { kind: normalizedKind });
};

const ensureMediaEnabled = async (page, kind) => {
  if (await mediaRowIsActive(page, kind)) {
    writeLog("info", "local_media_already_enabled", { kind });
    return;
  }
  await clickStatusToggle(page, kind);
  await waitForMediaEnabled(page, kind, mediaEnableTimeoutMs);
};

const computeStartupDelay = async () => {
  const baseDelayMs = Number.isFinite(slowStartMs) && slowStartMs > 0 ? slowStartMs : 0;
  if (!(Number.isFinite(startStaggerMs) && startStaggerMs > 0)) {
    return { totalDelayMs: baseDelayMs, slot: 0, staggerDelayMs: 0 };
  }

  await fs.promises.mkdir(startStaggerStateDir, { recursive: true });
  const lockPath = path.join(startStaggerStateDir, "slot.lock");
  const statePath = path.join(startStaggerStateDir, "slot-state.json");
  const lockHandle = await acquireFileLock(lockPath);

  let slot = 0;
  try {
    const nowMs = Date.now();
    let state = { nextSlot: 0, lastAssignedAtMs: 0 };

    try {
      const raw = await fs.promises.readFile(statePath, "utf8");
      const parsed = JSON.parse(raw);
      state = {
        nextSlot: Number.isFinite(parsed?.nextSlot) ? parsed.nextSlot : 0,
        lastAssignedAtMs: Number.isFinite(parsed?.lastAssignedAtMs)
          ? parsed.lastAssignedAtMs
          : 0,
      };
    } catch {
      // First startup or corrupt state; start from slot 0.
    }

    if (
      !Number.isFinite(state.lastAssignedAtMs) ||
      nowMs - state.lastAssignedAtMs > startStaggerResetMs
    ) {
      state.nextSlot = 0;
    }

    slot = Math.max(0, Math.floor(state.nextSlot));
    const nextState = {
      nextSlot: slot + 1,
      lastAssignedAtMs: nowMs,
    };
    await fs.promises.writeFile(
      statePath,
      `${JSON.stringify(nextState)}\n`,
      "utf8",
    );
  } finally {
    await lockHandle.close();
    await fs.promises.unlink(lockPath).catch(() => {});
  }

  const staggerDelayMs = slot * startStaggerMs;
  return {
    totalDelayMs: baseDelayMs + staggerDelayMs,
    slot,
    staggerDelayMs,
  };
};

let browser;
let closed = false;
let expectedBrowserDisconnect = false;

const flushAndExit = async (exitCode) => {
  if (closed) {
    return;
  }
  closed = true;

  if (browser) {
    try {
      expectedBrowserDisconnect = true;
      await browser.close();
      writeLog("info", "browser_closed");
    } catch (error) {
      writeLog("error", "browser_close_failed", {
        error: normalizeError(error),
      });
    }
  }

  await new Promise((resolve) => {
    logStream.end(resolve);
  });
  process.exit(exitCode);
};

process.on("unhandledRejection", (reason) => {
  writeLog("error", "unhandled_rejection", { error: normalizeError(reason) });
});
process.on("uncaughtException", (error) => {
  writeLog("error", "uncaught_exception", { error: normalizeError(error) });
  void flushAndExit(1);
});
process.on("SIGTERM", () => {
  writeLog("info", "signal_received", { signal: "SIGTERM" });
  void flushAndExit(0);
});
process.on("SIGINT", () => {
  writeLog("info", "signal_received", { signal: "SIGINT" });
  void flushAndExit(0);
});

writeLog("info", "bot_start", { logPath, slowStartMs, botIndexSource });

try {
  const startup = await computeStartupDelay();
  writeLog("info", "startup_delay", {
    delayMs: startup.totalDelayMs,
    baseDelayMs: slowStartMs,
    staggerDelayMs: startup.staggerDelayMs,
    staggerSlot: startup.slot,
    staggerStepMs: startStaggerMs,
  });
  if (startup.totalDelayMs > 0) {
    await sleep(startup.totalDelayMs);
  }

  browser = await puppeteer.launch({
    executablePath: chromiumExecutablePath,
    headless: true,
    dumpio: puppeteerDumpio,
    timeout: Number.parseInt(env.PUPPETEER_LAUNCH_TIMEOUT_MS || "60000", 10),
    ignoreHTTPSErrors: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--ignore-certificate-errors",
      "--allow-insecure-localhost",
      "--autoplay-policy=no-user-gesture-required",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--disable-dev-shm-usage",
      `--user-data-dir=${chromiumUserDataDir}`,
      ...(chromiumStderrLogging ? ["--enable-logging=stderr", "--v=1"] : []),
    ],
  });
  writeLog("info", "browser_launched", {
    executablePath: chromiumExecutablePath,
    userDataDir: chromiumUserDataDir,
    dumpio: puppeteerDumpio,
    chromiumStderrLogging,
  });

  browser.on("disconnected", () => {
    writeLog(expectedBrowserDisconnect ? "info" : "error", "browser_disconnected");
    if (!expectedBrowserDisconnect) {
      void flushAndExit(1);
    }
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(60000);
  await installSignalingProbe(page);

  page.on("console", (msg) => {
    writeLog("info", "page_console", {
      messageType: msg.type(),
      messageText: msg.text(),
      location: msg.location(),
    });
  });
  page.on("pageerror", (error) => {
    writeLog("error", "page_error", { error: normalizeError(error) });
  });
  page.on("error", (error) => {
    writeLog("error", "page_crash", { error: normalizeError(error) });
  });
  page.on("requestfailed", (request) => {
    writeLog("error", "request_failed", {
      url: request.url(),
      method: request.method(),
      failure: request.failure(),
      resourceType: request.resourceType(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      writeLog("error", "http_error_response", {
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  });

  writeLog("info", "navigate_start", { url: appUrl });
  await page.goto(appUrl, { waitUntil: "networkidle2" });
  writeLog("info", "navigate_complete", { url: appUrl });

  await page.waitForSelector(".room-input");
  writeLog("info", "room_input_ready");
  await page.click(".room-input", { clickCount: 3 });
  await page.type(".room-input", room);
  writeLog("info", "room_set", { room });

  await clickByText(page, ".room-toggle", "Join Room");
  await waitForRoomAttached(page);
  await waitForUplinkControlsEnabled(page);
  await waitForRoomEgressReady(page);
  await ensureMediaEnabled(page, "audio");
  await ensureMediaEnabled(page, "video");

  writeLog("info", "bot_ready");

  await new Promise(() => {});
} catch (error) {
  writeLog("error", "bot_run_failed", { error: normalizeError(error) });
  await flushAndExit(1);
}
