const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "[::]",
]);

const DEMO_WARM_MINUTES = 15;
const DEMO_SESSION_ESTIMATED_COST_USD = 0.09;
const PAYPAL_DONATE_URL = "https://www.paypal.com/donate";

export const isLocalHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
};

const startWaitingIndicator = (statusEl: HTMLElement): (() => void) => {
  const base = "Starting demo servers";
  let frame = 0;
  statusEl.classList.add("is-waiting");
  statusEl.textContent = `${base}.`;
  const timer = setInterval(() => {
    frame = (frame + 1) % 3;
    statusEl.textContent = `${base}${".".repeat(frame + 1)}`;
  }, 500);

  return () => {
    clearInterval(timer);
    statusEl.classList.remove("is-waiting");
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const appendLogLine = (logEl: HTMLTextAreaElement, line: string): void => {
  if (!line) {
    return;
  }
  const timestamp = new Date().toLocaleTimeString();
  logEl.value += `[${timestamp}] ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
};

const summarizeServices = (services: unknown): string => {
  if (!Array.isArray(services) || services.length === 0) {
    return "No service status available yet";
  }
  return services
    .map((svc: any) => {
      const name = svc.service ?? "unknown";
      const running = svc.runningCount ?? 0;
      const desired = svc.desiredCount ?? 0;
      const pending = svc.pendingCount ?? 0;
      const stable = svc.stable ? "stable" : "starting";
      return `${name}: ${running}/${desired} running, ${pending} pending (${stable})`;
    })
    .join(" | ");
};

const waitForDemoReady = async (
  statusEl: HTMLElement,
  detailEl: HTMLElement,
  logEl: HTMLTextAreaElement,
): Promise<boolean> => {
  const minWaitMs = 60_000;
  const timeoutMs = 14 * 60_000;
  const pollMs = 3000;
  const startedAt = Date.now();
  let checks = 0;
  let lastPhase = "";
  let lastSummary = "";

  while (Date.now() - startedAt < timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    checks += 1;
    detailEl.textContent = `Checks: ${checks} | Elapsed: ${elapsedSeconds}s | Timeout: ${Math.floor(
      timeoutMs / 1000,
    )}s`;

    let ready = false;
    try {
      const response = await fetch("/demo/status", { method: "GET", cache: "no-store" });
      if (response.ok) {
        const payload = await response.json();
        const phase = payload?.phase ?? "starting";
        const summary = summarizeServices(payload?.services);
        if (phase !== lastPhase || summary !== lastSummary) {
          appendLogLine(logEl, `Check ${checks}: ${payload?.message ?? "Status update"} (${phase})`);
          appendLogLine(logEl, summary);
          lastPhase = phase;
          lastSummary = summary;
        }
        ready = payload?.status === "ready";
      }
    } catch (err) {
      console.warn("Demo status endpoint failed.", err);
      appendLogLine(logEl, `Check ${checks}: status endpoint error`);
    }

    if (ready && elapsedMs >= minWaitMs) {
      statusEl.textContent = "Demo servers are ready. Connecting...";
      detailEl.textContent = `Checks: ${checks} | Elapsed: ${elapsedSeconds}s | Timeout: ${Math.floor(
        timeoutMs / 1000,
      )}s`;
      return true;
    }

    await sleep(pollMs);
  }

  statusEl.textContent = "Demo startup timed out. Please try again.";
  return false;
};

const startDemoProvisioning = async (
  statusEl: HTMLElement,
  detailEl: HTMLElement,
  logEl: HTMLTextAreaElement,
): Promise<boolean> => {
  const stopIndicator = startWaitingIndicator(statusEl);
  try {
    const response = await fetch("/demo/start", { method: "POST" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    appendLogLine(logEl, "Startup requested. Waiting for signaling, then media.");
    return await waitForDemoReady(statusEl, detailEl, logEl);
  } catch (err) {
    console.warn("Demo start endpoint failed.", err);
    statusEl.textContent = "Could not start demo servers. Please try again.";
    appendLogLine(logEl, `Startup request failed: ${String(err)}`);
    return false;
  } finally {
    stopIndicator();
  }
};

const waitForExistingProvisioning = async (
  statusEl: HTMLElement,
  detailEl: HTMLElement,
  logEl: HTMLTextAreaElement,
): Promise<boolean> => {
  const stopIndicator = startWaitingIndicator(statusEl);
  try {
    appendLogLine(logEl, "Demo services are already starting. Waiting for readiness.");
    return await waitForDemoReady(statusEl, detailEl, logEl);
  } finally {
    stopIndicator();
  }
};

export const mountStartModal = (onContinue: () => void): void => {
  const overlay = document.createElement("div");
  overlay.className = "cost-advisory-overlay";

  const modal = document.createElement("div");
  modal.className = "cost-advisory-modal";
  modal.innerHTML = `
    <h2>Click the button to prepare the demo</h2>
  `;

  const button = document.createElement("button");
  button.className = "cost-advisory-action";
  button.type = "button";
  button.textContent = "Start Demo Services";
  button.disabled = true;

  const explainer = document.createElement("p");
  explainer.className = "cost-advisory-explainer";
  explainer.innerHTML = `
    Starts the demo servers for <strong>${DEMO_WARM_MINUTES} minutes</strong> at no charge to you.
    Estimated AWS run cost per session: <strong>~$${DEMO_SESSION_ESTIMATED_COST_USD.toFixed(2)} USD</strong>.
  `;

  const status = document.createElement("p");
  status.className = "cost-advisory-status";
  status.textContent = "";

  const detail = document.createElement("p");
  detail.className = "cost-advisory-detail";
  detail.textContent = "";

  const log = document.createElement("textarea");
  log.className = "cost-advisory-log";
  log.readOnly = true;
  log.rows = 7;
  log.value = "";

  const donateCopy = document.createElement("p");
  donateCopy.className = "cost-advisory-donate-copy";
  donateCopy.textContent = "If this demo helps, please support it:";

  const donateButton = document.createElement("a");
  donateButton.className = "cost-advisory-donate-button";
  donateButton.href = PAYPAL_DONATE_URL;
  donateButton.target = "_blank";
  donateButton.rel = "noopener noreferrer";
  donateButton.textContent = "Donate with PayPal";

  button.addEventListener("click", async () => {
    button.disabled = true;
    const isReady = await startDemoProvisioning(status, detail, log);
    button.disabled = false;
    if (!isReady) {
      return;
    }
    overlay.remove();
    onContinue();
  });

  const syncExistingDemoState = async () => {
    status.textContent = "Checking demo status...";
    appendLogLine(log, "Checking current demo service status.");
    try {
      const response = await fetch("/demo/status", { method: "GET", cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = await response.json();
      if (payload?.status === "ready") {
        appendLogLine(log, "Demo services are already ready. Connecting now.");
        overlay.remove();
        onContinue();
        return;
      }

      if (payload?.status === "starting") {
        button.style.display = "none";
        const isReady = await waitForExistingProvisioning(status, detail, log);
        if (isReady) {
          overlay.remove();
          onContinue();
          return;
        }
        button.style.display = "";
        button.disabled = false;
        return;
      }
    } catch (err) {
      appendLogLine(log, `Status check failed: ${String(err)}`);
    }

    status.textContent = "";
    detail.textContent = "";
    button.style.display = "";
    button.disabled = false;
    appendLogLine(log, "Demo services are not running. Click start to begin.");
  };

  modal.appendChild(button);
  modal.appendChild(explainer);
  modal.appendChild(status);
  modal.appendChild(detail);
  modal.appendChild(log);
  modal.appendChild(donateCopy);
  modal.appendChild(donateButton);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  void syncExistingDemoState();
};
