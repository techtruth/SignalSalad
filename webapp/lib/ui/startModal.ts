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
const DEFAULT_BOT_COUNT = 20;
const MAX_BOT_COUNT = 50;
const BOT_REGION_OPTIONS = ["north_virginia", "north_california"] as const;
const DEFAULT_BOT_REGION = BOT_REGION_OPTIONS[0];
const DEMO_PAYMENT_CREATE_ENDPOINT = "/demo/payment/create";
const DEMO_PAYMENT_CAPTURE_ENDPOINT = "/demo/payment/capture";

const PAYPAL_DONATE_SDK_URL = "https://www.paypalobjects.com/donate/sdk/donate-sdk.js";
const PAYPAL_DONATE_HOSTED_BUTTON_ID = "TWEB9W6FH9KJL";

type PayPalDonateButton = {
  render: (selector: string) => void;
};

type PayPalDonation = {
  Button: (config: {
    env: "production";
    hosted_button_id: string;
    image: {
      src: string;
      alt: string;
      title: string;
    };
  }) => PayPalDonateButton;
};

type DemoStartRequest = {
  launchBots: boolean;
  botCount: number;
  botRegion: BotRegion;
  appUrl: string;
  room: string;
  payment: {
    mode: "mock" | "paypal";
    satisfied: boolean;
    token?: string;
    orderId?: string;
  };
};

type DemoBotProgress = {
  enabled: boolean;
  requested: number;
  invoked: number;
  online: number;
  failed: number;
  ready: boolean;
  launchId?: string;
};

type DemoStatusPayload = {
  status?: string;
  phase?: string;
  message?: string;
  services?: unknown;
  bots?: Partial<DemoBotProgress>;
  launch?: {
    launchBots?: boolean;
    botCount?: number;
    botRegion?: string;
  };
};

type BotRegion = (typeof BOT_REGION_OPTIONS)[number];

const normalizeBotRegion = (value: unknown): BotRegion => {
  const candidate = typeof value === "string" ? value.trim() : "";
  if ((BOT_REGION_OPTIONS as readonly string[]).includes(candidate)) {
    return candidate as BotRegion;
  }
  return DEFAULT_BOT_REGION;
};

declare global {
  interface Window {
    PayPal?: {
      Donation?: PayPalDonation;
    };
  }
}

let paypalDonateSdkPromise: Promise<void> | null = null;

const ensurePaypalDonateSdk = (): Promise<void> => {
  if (window.PayPal?.Donation?.Button) {
    return Promise.resolve();
  }
  if (paypalDonateSdkPromise) {
    return paypalDonateSdkPromise;
  }

  paypalDonateSdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PAYPAL_DONATE_SDK_URL}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("PayPal donate SDK failed to load")),
        {
          once: true,
        },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = PAYPAL_DONATE_SDK_URL;
    script.charset = "UTF-8";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener(
      "error",
      () => reject(new Error("PayPal donate SDK failed to load")),
      {
        once: true,
      },
    );
    document.body.appendChild(script);
  });

  return paypalDonateSdkPromise;
};

const mountPaypalDonateButton = async (targetSelector: string): Promise<void> => {
  await ensurePaypalDonateSdk();
  const donation = window.PayPal?.Donation;
  if (!donation?.Button) {
    throw new Error("PayPal donate SDK did not expose Donation.Button");
  }

  donation
    .Button({
      env: "production",
      hosted_button_id: PAYPAL_DONATE_HOSTED_BUTTON_ID,
      image: {
        src: "https://www.paypalobjects.com/en_US/i/btn/btn_donate_SM.gif",
        alt: "Donate with PayPal button",
        title: "PayPal - The safer, easier way to pay online!",
      },
    })
    .render(targetSelector);
};

export const isLocalHost = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
};

const startWaitingIndicator = (statusEl: HTMLElement): (() => void) => {
  const base = "Starting demo launcher";
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

  const mediaServices = services.filter(
    (svc: any) => String(svc?.tier ?? "").toLowerCase() === "media",
  );
  if (mediaServices.length === 0) {
    return "Media services: 0 running | 0 pending | Regions online: 0/0";
  }

  const running = mediaServices.reduce(
    (sum: number, svc: any) => sum + Number(svc?.runningCount ?? 0),
    0,
  );
  const pending = mediaServices.reduce(
    (sum: number, svc: any) => sum + Number(svc?.pendingCount ?? 0),
    0,
  );

  const regions = new Map<string, { running: number; serviceCount: number }>();
  for (const svc of mediaServices as any[]) {
    const region = String(svc?.region ?? "unknown");
    const entry = regions.get(region) ?? { running: 0, serviceCount: 0 };
    entry.running += Number(svc?.runningCount ?? 0);
    entry.serviceCount += 1;
    regions.set(region, entry);
  }

  const totalRegions = regions.size;
  const onlineRegions = [...regions.values()].filter((entry) => entry.running > 0).length;

  return `Media running: ${running} | pending: ${pending} | Regions online: ${onlineRegions}/${totalRegions}`;
};

const summarizeBots = (payload: DemoStatusPayload): string | null => {
  const bots = payload.bots;
  if (!bots || !bots.enabled) {
    return null;
  }
  const requested = Number(bots.requested ?? 0);
  const invoked = Number(bots.invoked ?? 0);
  const online = Number(bots.online ?? 0);
  const failed = Number(bots.failed ?? 0);
  const ready = Boolean(bots.ready);
  return `Bots requested: ${requested} | invoked: ${invoked} | online: ${online} | failed: ${failed} | ready: ${ready}`;
};

const normalizeBotProgress = (payload: DemoStatusPayload): DemoBotProgress => {
  const bots = payload.bots ?? {};
  return {
    enabled: Boolean(bots.enabled),
    requested: Number(bots.requested ?? 0),
    invoked: Number(bots.invoked ?? 0),
    online: Number(bots.online ?? 0),
    failed: Number(bots.failed ?? 0),
    ready: Boolean(bots.ready),
    launchId: typeof bots.launchId === "string" ? bots.launchId : undefined,
  };
};

const isStartupInProgress = (payload: DemoStatusPayload): boolean => {
  const services = Array.isArray(payload?.services) ? payload.services : [];
  return services.some((svc: any) => {
    const desired = Number(svc?.desiredCount ?? 0);
    const running = Number(svc?.runningCount ?? 0);
    const pending = Number(svc?.pendingCount ?? 0);
    return desired > 0 || running > 0 || pending > 0;
  });
};

const waitForDemoReady = async (
  statusEl: HTMLElement,
  detailEl: HTMLElement,
  logEl: HTMLTextAreaElement,
  expectedLaunch: { launchBots: boolean; botCount: number },
): Promise<boolean> => {
  const minWaitMs = 60_000;
  const timeoutMs = 14 * 60_000;
  const pollMs = 3000;
  const startedAt = Date.now();

  let lastPhase = "";
  let lastSummary = "";
  let lastBotSummary = "";

  while (Date.now() - startedAt < timeoutMs) {
    const elapsedMs = Date.now() - startedAt;
    const elapsedSeconds = Math.floor(elapsedMs / 1000);
    detailEl.textContent = `Elapsed: ${elapsedSeconds}s | Timeout: ${Math.floor(timeoutMs / 1000)}s`;

    let ready = false;
    try {
      const response = await fetch("/demo/status", { method: "GET", cache: "no-store" });
      if (response.ok) {
        const payload = (await response.json()) as DemoStatusPayload;
        const phase = payload?.phase ?? "starting";
        const summary = summarizeServices(payload?.services);
        const botSummary = summarizeBots(payload) ?? "";

        if (phase !== lastPhase || summary !== lastSummary || botSummary !== lastBotSummary) {
          appendLogLine(logEl, `${payload?.message ?? "Status update"} (${phase})`);
          appendLogLine(logEl, summary);
          if (botSummary) {
            appendLogLine(logEl, botSummary);
          }
          lastPhase = phase;
          lastSummary = summary;
          lastBotSummary = botSummary;
        }

        ready = payload?.status === "ready";
        if (payload?.status === "failed") {
          statusEl.textContent = payload?.message ?? "Demo startup failed.";
          return false;
        }
        if (expectedLaunch.launchBots) {
          const botProgress = normalizeBotProgress(payload);
          // Deterministic launch requirement: modal only exits when launcher confirms bot readiness.
          ready = ready && botProgress.ready;
        }
      }
    } catch (err) {
      console.warn("Demo status endpoint failed.", err);
      appendLogLine(logEl, "Status endpoint error");
    }

    if (ready && elapsedMs >= minWaitMs) {
      statusEl.textContent = expectedLaunch.launchBots
        ? "Demo servers and bots are ready. Connecting..."
        : "Demo servers are ready. Connecting...";
      detailEl.textContent = `Elapsed: ${elapsedSeconds}s | Timeout: ${Math.floor(timeoutMs / 1000)}s`;
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
  request: DemoStartRequest,
): Promise<boolean> => {
  const stopIndicator = startWaitingIndicator(statusEl);
  try {
    const response = await fetch("/demo/start", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    appendLogLine(
      logEl,
      request.launchBots
        ? `Startup requested with bots: count=${request.botCount}, region=${request.botRegion}. Waiting for signaling, media, then bots.`
        : "Startup requested. Waiting for signaling, then media.",
    );

    return await waitForDemoReady(statusEl, detailEl, logEl, {
      launchBots: request.launchBots,
      botCount: request.botCount,
    });
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
  launch: { launchBots: boolean; botCount: number },
): Promise<boolean> => {
  const stopIndicator = startWaitingIndicator(statusEl);
  try {
    appendLogLine(
      logEl,
      launch.launchBots
        ? `Demo services are already starting with bots (count=${launch.botCount}). Waiting for readiness.`
        : "Demo services are already starting. Waiting for readiness.",
    );
    return await waitForDemoReady(statusEl, detailEl, logEl, launch);
  } finally {
    stopIndicator();
  }
};

const makePaypalPaymentToken = (): string => `paypal-payment-${Date.now()}`;

type PaymentCreateResponse = {
  status?: string;
  orderId?: string;
  approvalUrl?: string;
  botCount?: number;
};

type PaymentCaptureResponse = {
  status?: string;
  payment?: {
    completed?: boolean;
    orderId?: string;
    paidBotCount?: number;
    paymentStatus?: string;
    capturedAmount?: string;
  };
};

export const mountStartModal = (onContinue: () => void): void => {
  const overlay = document.createElement("div");
  overlay.className = "cost-advisory-overlay";

  const modal = document.createElement("div");
  modal.className = "cost-advisory-modal";
  modal.innerHTML = `
    <h2>Prepare Demo Session</h2>
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

  const launchBotsRow = document.createElement("label");
  launchBotsRow.className = "cost-advisory-toggle-row";
  const launchBotsCheckbox = document.createElement("input");
  launchBotsCheckbox.type = "checkbox";
  launchBotsCheckbox.className = "cost-advisory-checkbox";
  const launchBotsText = document.createElement("span");
  launchBotsText.textContent = "Also launch demo bots";
  launchBotsRow.appendChild(launchBotsCheckbox);
  launchBotsRow.appendChild(launchBotsText);

  const botCountRow = document.createElement("label");
  botCountRow.className = "cost-advisory-bot-count";
  botCountRow.textContent = "Bot count";
  const botCountInput = document.createElement("input");
  botCountInput.type = "number";
  botCountInput.min = "1";
  botCountInput.max = `${MAX_BOT_COUNT}`;
  botCountInput.step = "1";
  botCountInput.value = `${DEFAULT_BOT_COUNT}`;
  botCountInput.className = "cost-advisory-bot-count-input";
  botCountRow.appendChild(botCountInput);

  const botRegionRow = document.createElement("label");
  botRegionRow.className = "cost-advisory-bot-region";
  botRegionRow.textContent = "Bot region";
  const botRegionSelect = document.createElement("select");
  botRegionSelect.className = "cost-advisory-bot-region-select";
  for (const region of BOT_REGION_OPTIONS) {
    const option = document.createElement("option");
    option.value = region;
    option.textContent = region;
    botRegionSelect.appendChild(option);
  }
  botRegionSelect.value = DEFAULT_BOT_REGION;
  botRegionRow.appendChild(botRegionSelect);

  const paymentPanel = document.createElement("div");
  paymentPanel.className = "cost-advisory-payment";

  const paymentCopy = document.createElement("p");
  paymentCopy.className = "cost-advisory-payment-copy";
  paymentCopy.textContent = "Bots require payment before startup.";

  const paymentStatus = document.createElement("p");
  paymentStatus.className = "cost-advisory-payment-status";
  paymentStatus.textContent = "Payment status: pending";

  const paymentContainer = document.createElement("div");
  paymentContainer.innerHTML = `
    <style>
      .pp-GVLHP2N5JDNGU {
        text-align: center;
        border: none;
        border-radius: 0.25rem;
        min-width: 11.625rem;
        padding: 0 2rem;
        height: 2.625rem;
        font-weight: bold;
        background-color: #FFD140;
        color: #000000;
        font-family: "Helvetica Neue", Arial, sans-serif;
        font-size: 1rem;
        line-height: 1.25rem;
        cursor: pointer;
      }
    </style>
    <div style="display:inline-grid;justify-items:center;align-content:start;gap:0.5rem;">
      <button class="pp-GVLHP2N5JDNGU" type="button" data-paypal-pay>Pay with PayPal</button>
      <img src="https://www.paypalobjects.com/images/Debit_Credit_APM.svg" alt="cards" />
      <section style="font-size:0.75rem;">
        Powered by
        <img
          src="https://www.paypalobjects.com/paypal-ui/logos/svg/paypal-wordmark-color.svg"
          alt="paypal"
          style="height:0.875rem;vertical-align:middle;"
        />
      </section>
    </div>
  `;
  const paymentPayButton = paymentContainer.querySelector(
    "[data-paypal-pay]",
  ) as HTMLButtonElement | null;

  paymentPanel.appendChild(paymentCopy);
  paymentPanel.appendChild(paymentStatus);
  paymentPanel.appendChild(paymentContainer);

  const status = document.createElement("p");
  status.className = "cost-advisory-status";
  status.textContent = "";

  const detail = document.createElement("p");
  detail.className = "cost-advisory-detail";
  detail.textContent = "";

  const log = document.createElement("textarea");
  log.className = "cost-advisory-log";
  log.readOnly = true;
  log.rows = 8;
  log.value = "";

  const donateCopy = document.createElement("p");
  donateCopy.className = "cost-advisory-donate-copy";
  donateCopy.textContent = "Optional: support the project";

  const donateButtonContainer = document.createElement("div");
  donateButtonContainer.id = "donate-button-container";
  donateButtonContainer.className = "cost-advisory-donate-button";

  const donateButton = document.createElement("div");
  donateButton.id = "donate-button";
  donateButtonContainer.appendChild(donateButton);

  let launchInFlight = false;
  let paypalPaymentSatisfied = false;
  let paypalPaymentToken = "";
  let paypalOrderId = "";
  let paypalPaidBotCount = 0;
  let paypalVerifyInFlight = false;

  const readBotCount = () => {
    const parsed = Number.parseInt(botCountInput.value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      return DEFAULT_BOT_COUNT;
    }
    return Math.min(parsed, MAX_BOT_COUNT);
  };

  const syncPaymentQuantity = () => {
    const quantity = readBotCount();
    return quantity;
  };

  const updatePaymentUi = () => {
    const launchBots = launchBotsCheckbox.checked;
    paymentPanel.style.display = launchBots ? "" : "none";
    botCountRow.style.display = launchBots ? "" : "none";
    botRegionRow.style.display = launchBots ? "" : "none";

    if (!launchBots) {
      paymentStatus.textContent = "Payment status: not required";
      return;
    }

    syncPaymentQuantity();
    paymentStatus.textContent = paypalPaymentSatisfied
      ? `Payment status: satisfied (paid bots: ${paypalPaidBotCount})`
      : paypalOrderId
        ? `Payment status: pending verification for order ${paypalOrderId}`
        : "Payment status: pending";
  };

  const updateControlState = () => {
    const launchBots = launchBotsCheckbox.checked;
    const paymentRequired = launchBots;
    const paymentMissing = paymentRequired && !paypalPaymentSatisfied;

    launchBotsCheckbox.disabled = launchInFlight;
    botCountInput.disabled = launchInFlight || !launchBots;
    botRegionSelect.disabled = launchInFlight || !launchBots;
    paymentContainer.style.display = launchBots && paypalPaymentSatisfied ? "none" : "";
    if (paymentPayButton) {
      paymentPayButton.disabled = launchInFlight || !launchBots;
    }

    button.disabled = launchInFlight || paymentMissing;
    if (!launchBots && !launchInFlight) {
      button.disabled = false;
    }
    button.style.display = launchInFlight ? "none" : "";

    updatePaymentUi();
  };

  launchBotsCheckbox.addEventListener("change", () => {
    paypalPaymentSatisfied = false;
    paypalPaymentToken = "";
    paypalOrderId = "";
    paypalPaidBotCount = 0;
    appendLogLine(
      log,
      launchBotsCheckbox.checked
        ? "Bots launch enabled. Create and complete a PayPal payment."
        : "Bots launch disabled.",
    );
    updateControlState();
  });

  botCountInput.addEventListener("input", () => {
    paypalPaymentSatisfied = false;
    paypalPaymentToken = "";
    paypalOrderId = "";
    paypalPaidBotCount = 0;
    syncPaymentQuantity();
    updateControlState();
  });

  paymentPayButton?.addEventListener("click", async () => {
    const botCount = syncPaymentQuantity();
    try {
      const response = await fetch(DEMO_PAYMENT_CREATE_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          botCount,
          botRegion: normalizeBotRegion(botRegionSelect.value),
          appUrl: window.location.origin,
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as PaymentCreateResponse;
      if (!payload.orderId || !payload.approvalUrl) {
        throw new Error("Payment create response missing orderId or approvalUrl");
      }

      paypalOrderId = payload.orderId;
      paypalPaymentToken = makePaypalPaymentToken();
      paypalPaymentSatisfied = false;
      paypalPaidBotCount = 0;
      appendLogLine(
        log,
        `PayPal order created (${paypalOrderId}) for ${botCount} bots. Redirecting to checkout.`,
      );
      window.location.assign(payload.approvalUrl);
    } catch (err) {
      appendLogLine(log, `PayPal payment create failed: ${String(err)}`);
    } finally {
      updateControlState();
    }
  });

  const verifyPaypalPayment = async () => {
    if (paypalVerifyInFlight || !paypalOrderId) {
      return;
    }
    paypalVerifyInFlight = true;
    try {
      const response = await fetch(DEMO_PAYMENT_CAPTURE_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ orderId: paypalOrderId }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const payload = (await response.json()) as PaymentCaptureResponse;
      const completed = Boolean(payload.payment?.completed);
      const paidBotCount = Number(payload.payment?.paidBotCount ?? 0);
      if (!completed || paidBotCount < 1) {
        appendLogLine(
          log,
          `PayPal payment not completed yet (status=${payload.payment?.paymentStatus ?? "unknown"}).`,
        );
        paypalPaymentSatisfied = false;
        updateControlState();
        return;
      }

      paypalPaymentSatisfied = true;
      paypalPaidBotCount = paidBotCount;
      botCountInput.value = String(paidBotCount);
      appendLogLine(
        log,
        `PayPal payment verified for order ${paypalOrderId}. Paid bots: ${paidBotCount}.`,
      );
      updateControlState();
    } catch (err) {
      appendLogLine(log, `PayPal payment verification failed: ${String(err)}`);
      paypalPaymentSatisfied = false;
      updateControlState();
    } finally {
      paypalVerifyInFlight = false;
    }
  };

  const maybeAutoVerifyFromReturn = async () => {
    const params = new URLSearchParams(window.location.search);
    const returnedOrderId = params.get("token");
    const paypalReturn = params.get("paypalReturn") === "1";
    if (!paypalReturn || !returnedOrderId) {
      return;
    }
    if (!launchBotsCheckbox.checked) {
      launchBotsCheckbox.checked = true;
    }

    paypalOrderId = returnedOrderId;
    appendLogLine(log, `Detected PayPal return for order ${paypalOrderId}. Verifying payment.`);
    updateControlState();
    void verifyPaypalPayment();
  };

  window.addEventListener("focus", () => {
    if (paypalOrderId && !paypalPaymentSatisfied) {
      void verifyPaypalPayment();
    }
  });

  button.addEventListener("click", async () => {
    launchInFlight = true;
    updateControlState();

    const launchBots = launchBotsCheckbox.checked;
    const botCount = launchBots ? readBotCount() : 0;

    const request: DemoStartRequest = {
      launchBots,
      botCount,
      botRegion: normalizeBotRegion(botRegionSelect.value),
      appUrl: window.location.origin,
      room: "demo",
      payment: {
        mode: "paypal",
        satisfied: !launchBots || paypalPaymentSatisfied,
        token: launchBots ? paypalPaymentToken : undefined,
        orderId: launchBots ? paypalOrderId : undefined,
      },
    };

    const isReady = await startDemoProvisioning(status, detail, log, request);
    if (!isReady) {
      launchInFlight = false;
      updateControlState();
      return;
    }

    overlay.remove();
    onContinue();
  });

  const syncExistingDemoState = async () => {
    status.textContent = "";
    appendLogLine(log, "Checking current demo service status.");

    try {
      const response = await fetch("/demo/status", { method: "GET", cache: "no-store" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = (await response.json()) as DemoStatusPayload;
      if (payload?.status === "ready") {
        appendLogLine(log, "Demo services are already ready. Connecting now.");
        overlay.remove();
        onContinue();
        return;
      }

      if (payload?.status === "starting" && isStartupInProgress(payload)) {
        const launchBots = Boolean(payload?.launch?.launchBots);
        const botCount = Number(payload?.launch?.botCount ?? 0);
        const botRegion = normalizeBotRegion(payload?.launch?.botRegion);

        launchBotsCheckbox.checked = launchBots;
        if (launchBots && botCount > 0) {
          botCountInput.value = String(botCount);
        }
        botRegionSelect.value = botRegion;

        launchInFlight = true;
        updateControlState();

        const isReady = await waitForExistingProvisioning(status, detail, log, {
          launchBots,
          botCount,
        });
        if (isReady) {
          overlay.remove();
          onContinue();
          return;
        }

        launchInFlight = false;
        updateControlState();
        return;
      }
    } catch (err) {
      appendLogLine(log, `Status check failed: ${String(err)}`);
    }

    status.textContent = "";
    detail.textContent = "";
    launchInFlight = false;
    updateControlState();
    appendLogLine(log, "Demo services are not running. Configure and start.");
  };

  modal.appendChild(button);
  modal.appendChild(explainer);
  modal.appendChild(launchBotsRow);
  modal.appendChild(botCountRow);
  modal.appendChild(botRegionRow);
  modal.appendChild(paymentPanel);
  modal.appendChild(status);
  modal.appendChild(detail);
  modal.appendChild(log);
  modal.appendChild(donateCopy);
  modal.appendChild(donateButtonContainer);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  updateControlState();
  void maybeAutoVerifyFromReturn();

  void mountPaypalDonateButton("#donate-button").catch((err) => {
    appendLogLine(log, `PayPal donate button unavailable: ${String(err)}`);
  });
  void syncExistingDemoState();
};
