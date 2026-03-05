/**
 * Webapp entrypoint: wires controller, adapters, and UI panels.
 * Keeps bootstrap minimal so feature logic lives in modules.
 */
import "./style.css";
import { MediasoupSessionController } from "./lib/controllers/mediasoupSessionController";
import { DownlinkPanel } from "./lib/ui/downlinkPanel";
import { LocalMediaPanel } from "./lib/ui/localMediaPanel";
import { isLocalHost, mountStartModal } from "./lib/ui/startModal";
import { StatusDiagram, StatusLegend } from "./lib/ui/statusDiagram";

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

const forceCostAdvisory =
  new URLSearchParams(window.location.search).get("demoModal") === "1";

if (!forceCostAdvisory && isLocalHost(window.location.hostname)) {
  bootstrapApp();
} else {
  mountStartModal(bootstrapApp);
}
