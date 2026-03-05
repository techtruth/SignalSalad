/**
 * Webapp entrypoint: wires controller, adapters, and UI panels.
 * Keeps bootstrap minimal so feature logic lives in modules.
 */
import "./style.css";
import { MediasoupSessionController } from "./lib/controllers/mediasoupSessionController";
import { DownlinkPanel } from "./lib/ui/downlinkPanel";
import { LocalMediaPanel } from "./lib/ui/localMediaPanel";
import { StatusDiagram, StatusLegend } from "./lib/ui/statusDiagram";

const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
  "[::]",
]);

const DEMO_WARM_MINUTES = 15;
const DEMO_SESSION_ESTIMATED_COST_USD = 0.06;
const PAYPAL_DONATE_URL = "https://www.paypal.com/donate";

const isLocalHost = (hostname) => {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  );
};

const startWaitingIndicator = (statusEl) => {
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitForDemoReady = async (statusEl, detailEl) => {
  const minWaitMs = 60_000;
  const timeoutMs = 14 * 60_000;
  const pollMs = 3000;
  const startedAt = Date.now();
  let checks = 0;

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
        ready = payload?.status === "ready";
      }
    } catch (err) {
      console.warn("Demo status endpoint failed.", err);
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

const startDemoProvisioning = async (statusEl, detailEl) => {
  const stopIndicator = startWaitingIndicator(statusEl);
  try {
    const response = await fetch("/demo/start", { method: "POST" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await waitForDemoReady(statusEl, detailEl);
  } catch (err) {
    console.warn("Demo start endpoint failed.", err);
    statusEl.textContent = "Could not start demo servers. Please try again.";
    return false;
  } finally {
    stopIndicator();
  }
};

const mountCostAdvisory = (onContinue) => {
  const overlay = document.createElement("div");
  overlay.className = "cost-advisory-overlay";

  const modal = document.createElement("div");
  modal.className = "cost-advisory-modal";
  modal.innerHTML = `
    <h2>Click the button to start demo servers</h2>
  `;

  const button = document.createElement("button");
  button.className = "cost-advisory-action";
  button.type = "button";
  button.textContent = "Start Demo Servers";

  const explainer = document.createElement("p");
  explainer.className = "cost-advisory-explainer";
  explainer.innerHTML = `
    Starts the demo services for <strong>${DEMO_WARM_MINUTES} minutes</strong> at no charge to you.
    Estimated AWS run cost per session: <strong>~$${DEMO_SESSION_ESTIMATED_COST_USD.toFixed(2)} USD</strong>.
  `;

  const status = document.createElement("p");
  status.className = "cost-advisory-status";
  status.textContent = "";

  const detail = document.createElement("p");
  detail.className = "cost-advisory-detail";
  detail.textContent = "";

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
    const isReady = await startDemoProvisioning(status, detail);
    button.disabled = false;
    if (!isReady) {
      return;
    }
    overlay.remove();
    onContinue();
  });

  modal.appendChild(button);
  modal.appendChild(explainer);
  modal.appendChild(status);
  modal.appendChild(detail);
  modal.appendChild(donateCopy);
  modal.appendChild(donateButton);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
};

const bootstrapApp = () => {
  const appLayout = document.createElement("div");
  appLayout.className = "app-layout";
  const mainColumn = document.createElement("div");
  mainColumn.className = "app-main";
  const sideColumn = document.createElement("div");
  sideColumn.className = "app-sidebar";
  const diagramWrap = document.createElement("div");
  diagramWrap.className = "diagram-wrap";
  mainColumn.appendChild(diagramWrap);
  appLayout.appendChild(mainColumn);
  appLayout.appendChild(sideColumn);
  document.body.appendChild(appLayout);

  const signalingUrl =
    window.location.protocol === "https:"
      ? "wss://" + window.location.host
      : "ws://" + window.location.host;
  const sessionController = new MediasoupSessionController(signalingUrl);
  const downlinkPanel = new DownlinkPanel();
  const statusDiagram = new StatusDiagram();
  const localPanel = new LocalMediaPanel();
  const statusLegend = new StatusLegend(sessionController, signalingUrl);

  const bindDownlink = () => {
    sessionController.on("peerConnected", (peerId) => {
      downlinkPanel.addPeer(peerId);
    });
    sessionController.on("peerDisconnected", (peerId) => {
      downlinkPanel.removePeer(peerId);
    });
    sessionController.on("peerMediaOpened", (peerId, kind, track) => {
      if (kind === "audio") {
        downlinkPanel.attachAudio(peerId, track);
        return;
      }
      downlinkPanel.attachVideo(peerId, track);
    });
    sessionController.on("peerMediaClosed", (peerId, kind) => {
      if (kind === "audio") {
        downlinkPanel.setAudioOff(peerId);
      } else if (kind === "video") {
        downlinkPanel.setVideoOff(peerId);
      }
    });
  };

  const bindLocalPanel = () => {
    sessionController.on("identityAssigned", (selfId) => {
      localPanel.setIdentity(selfId);
    });
    sessionController.on("roomAttached", (room) => {
      localPanel.setRoomAttached(room);
    });
    sessionController.on("roomDetached", () => {
      localPanel.setRoomDetached();
      downlinkPanel.clearPeers();
    });
    sessionController.on("transportSignalingStatus", (isConnected) => {
      localPanel.setSignalingState(isConnected);
    });
    sessionController.on("transportIngressReady", (ready) => {
      localPanel.setUplinkReady(ready);
    });
    sessionController.on("localMediaOpened", (kind, track, appData) => {
      localPanel.setLocalMediaOpened(kind, track, appData);
    });
    sessionController.on("localMediaClosed", (kind, appData) => {
      localPanel.setLocalMediaClosed(kind, appData);
    });
  };

  const bindStatus = () => {
    sessionController.on("systemStatus", (data) => {
      statusDiagram.update(data);
    });
  };

  bindDownlink();
  bindLocalPanel();
  bindStatus();
  downlinkPanel.setHandlers({
    onRequestClientMute: (peerId, muted) =>
      sessionController.requestPeerClientMute(peerId, muted),
    onRequestServerMute: (peerId, muted) =>
      sessionController.requestPeerServerMute(peerId, muted),
  });
  localPanel.setHandlers({
    onToggleAudio: () => sessionController.toggleMicrophone(),
    onToggleVideo: () => sessionController.toggleWebcam(),
    onJoinRoom: (room) => sessionController.attachRoom(room),
    onLeaveRoom: () => sessionController.detachRoom(),
  });
  statusLegend.mount(diagramWrap);
  statusDiagram.mount(diagramWrap);
  localPanel.mount(sideColumn);
  downlinkPanel.mount(sideColumn);
  sessionController.connectSignaling();
};

if (isLocalHost(window.location.hostname)) {
  bootstrapApp();
} else {
  mountCostAdvisory(bootstrapApp);
}
