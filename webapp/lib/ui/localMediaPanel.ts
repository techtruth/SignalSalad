/**
 * Uplink panel UI: renders local media controls and status indicators.
 * Kept separate so DOM layout stays isolated from controller signaling logic.
 */
import type { AppData } from "mediasoup-client/lib/types";
import { createAudioMeter } from "./audioMeter";

const shortId = (id: string) => id.split("-")[0];

type RowElements = {
  row: HTMLDivElement;
  onDot: HTMLSpanElement;
  sendingDot: HTMLSpanElement;
  toggleBtn: HTMLButtonElement;
};

function applyDot(dot: HTMLSpanElement, active: boolean) {
  dot.classList.toggle("on", active);
}

function createRow(label: string): RowElements {
  const row = document.createElement("div");
  row.className = "status-row";
  const badges = document.createElement("div");
  badges.className = "status-badges";
  const onDot = document.createElement("span");
  onDot.className = "status-dot";
  onDot.title = "enabled";
  const sendingDot = document.createElement("span");
  sendingDot.className = "status-dot";
  sendingDot.title = "uploading";
  const sendingLabel = document.createElement("span");
  sendingLabel.className = "status-label";
  const toggleBtn = document.createElement("button");
  toggleBtn.className = "status-toggle";
  toggleBtn.type = "button";
  toggleBtn.textContent = label + " on/off";
  badges.appendChild(onDot);
  badges.appendChild(document.createTextNode(" enabled "));
  badges.appendChild(sendingDot);
  sendingLabel.textContent = "uploading";
  badges.appendChild(sendingLabel);
  row.appendChild(toggleBtn);
  row.appendChild(badges);
  return { row, onDot, sendingDot, toggleBtn };
}

/**
 * Event hooks for UI button actions.
 * @category Implementer API
 */
export type LocalMediaPanelHandlers = {
  onToggleAudio?: () => void;
  onToggleVideo?: () => void;
  onJoinRoom?: (room?: string) => void;
  onLeaveRoom?: () => void;
};

/**
 * Methods exposed by the uplink panel to reflect harness state.
 * @category Implementer API
 */
export type LocalMediaPanelHandle = {
  setIdentity: (peerId: string) => void;
  setRoomAttached: (room: string) => void;
  setRoomDetached: () => void;
  setUplinkReady: (ready: boolean) => void;
  setSignalingState: (connected: boolean) => void;
  setLocalMediaOpened: (
    kind: "audio" | "video",
    track: MediaStreamTrack,
    appData: AppData | undefined,
  ) => void;
  setLocalMediaClosed: (
    kind: "audio" | "video",
    appData: AppData | undefined,
  ) => void;
  setHandlers: (handlers: LocalMediaPanelHandlers) => void;
};

/**
 * Uplink panel class. Owns DOM for local media controls and indicators.
 * @category Implementer API
 */
export class LocalMediaPanel implements LocalMediaPanelHandle {
  panel: HTMLDivElement;
  setIdentity: (peerId: string) => void;
  setRoomAttached: (room: string) => void;
  setRoomDetached: () => void;
  setUplinkReady: (ready: boolean) => void;
  setSignalingState: (connected: boolean) => void;
  setLocalMediaOpened: (
    kind: "audio" | "video",
    track: MediaStreamTrack,
    appData: AppData | undefined,
  ) => void;
  setLocalMediaClosed: (
    kind: "audio" | "video",
    appData: AppData | undefined,
  ) => void;
  setHandlers: (handlers: LocalMediaPanelHandlers) => void;

  constructor() {
    this.panel = document.createElement("div");
    this.panel.className = "media-status-panel";

    const headerBar = document.createElement("div");
    headerBar.className = "panel-header";
    const headerTitle = document.createElement("span");
    headerTitle.className = "panel-title";
    headerTitle.textContent = "Uplink";
    const linkDot = document.createElement("span");
    linkDot.className = "status-dot";
    linkDot.title = "uplink";
    const roomToggle = document.createElement("button");
    roomToggle.type = "button";
    roomToggle.className = "room-toggle";
    roomToggle.textContent = "Join Room";
    roomToggle.disabled = true;
    const roomInput = document.createElement("input");
    roomInput.type = "text";
    roomInput.className = "room-input";
    roomInput.placeholder = "room";
    roomInput.autocomplete = "off";
    roomInput.value = "demo";
    const roomDot = document.createElement("span");
    roomDot.className = "status-dot";
    roomDot.title = "room member";
    const titleWrap = document.createElement("div");
    titleWrap.className = "panel-title-wrap";
    titleWrap.appendChild(headerTitle);
    titleWrap.appendChild(linkDot);
    titleWrap.appendChild(roomDot);
    titleWrap.appendChild(roomInput);
    titleWrap.appendChild(roomToggle);
    headerBar.appendChild(titleWrap);
    this.panel.appendChild(headerBar);

    const peerHeader = document.createElement("div");
    peerHeader.className = "peer-card-header";
    const peerLabel = document.createElement("span");
    peerLabel.className = "peer-id";
    peerLabel.textContent = "UserID —";
    peerHeader.appendChild(peerLabel);
    this.panel.appendChild(peerHeader);

    const audioRow = createRow("Audio");
    const videoRow = createRow("Video");
    this.panel.appendChild(audioRow.row);
    this.panel.appendChild(videoRow.row);

    const previewWrapper = document.createElement("div");
    previewWrapper.className = "preview-wrapper";
    const previewVideoWrap = document.createElement("div");
    previewVideoWrap.className = "preview-video-wrap";
    const videoPreview = document.createElement("video");
    videoPreview.autoplay = true;
    videoPreview.muted = true;
    videoPreview.playsInline = true;
    videoPreview.className = "preview-video";
    videoPreview.style.display = "none";
    const previewSizeBadge = document.createElement("div");
    previewSizeBadge.className = "preview-video-size";
    previewSizeBadge.style.display = "none";
    previewVideoWrap.appendChild(videoPreview);
    previewVideoWrap.appendChild(previewSizeBadge);
    previewWrapper.appendChild(previewVideoWrap);
    const audioMeterEl = document.createElement("div");
    audioMeterEl.className = "audio-meter";
    audioMeterEl.style.display = "none";
    const audioLevel = document.createElement("div");
    audioLevel.className = "audio-level";
    audioMeterEl.appendChild(audioLevel);
    previewWrapper.appendChild(audioMeterEl);
    this.panel.appendChild(previewWrapper);

    const audioMeter = createAudioMeter(audioLevel);
    const state = {
      identityAssigned: false,
      joined: false,
      signalingConnected: false,
      uplinkReady: false,
      audioTrack: undefined as MediaStreamTrack | undefined,
      videoTrack: undefined as MediaStreamTrack | undefined,
      peerId: undefined as string | undefined,
    };
    let handlers: LocalMediaPanelHandlers = {};
    const updatePreviewSize = () => {
      const width = videoPreview.videoWidth;
      const height = videoPreview.videoHeight;
      if (width > 0 && height > 0) {
        previewSizeBadge.textContent = `${width}×${height}`;
        previewSizeBadge.style.display = "block";
      } else {
        previewSizeBadge.textContent = "";
        previewSizeBadge.style.display = "none";
      }
    };
    videoPreview.addEventListener("loadedmetadata", updatePreviewSize);
    videoPreview.addEventListener("resize", updatePreviewSize);

    const render = () => {
      roomToggle.textContent = state.joined ? "Leave Room" : "Join Room";
      roomToggle.classList.toggle("joined", state.joined);
      applyDot(roomDot, state.joined);
      const canToggle = state.joined && state.uplinkReady;
      audioRow.toggleBtn.disabled = !canToggle;
      videoRow.toggleBtn.disabled = !canToggle;
      const toggleHint = state.joined
        ? state.uplinkReady
          ? "Toggle local media"
          : "Waiting for uplink transport"
        : "Join a room to enable";
      audioRow.toggleBtn.title = toggleHint;
      videoRow.toggleBtn.title = toggleHint;

      const hasAudio = !!state.audioTrack;
      const hasVideo = !!state.videoTrack;
      applyDot(linkDot, hasAudio || hasVideo);
      peerLabel.textContent = state.peerId
        ? `UserID ${shortId(state.peerId)}`
        : "UserID —";
      roomInput.disabled = state.joined;
      const hasRoom = roomInput.value.trim().length > 0;
      const canControlRoom = state.identityAssigned && state.signalingConnected;
      roomToggle.disabled = state.joined
        ? !canControlRoom
        : !canControlRoom || !hasRoom;

      applyDot(audioRow.onDot, state.joined && hasAudio);
      applyDot(audioRow.sendingDot, state.joined && hasAudio);
      applyDot(videoRow.onDot, state.joined && hasVideo);
      applyDot(videoRow.sendingDot, state.joined && hasVideo);


      if (state.videoTrack) {
        videoPreview.style.display = "block";
        const stream =
          videoPreview.srcObject instanceof MediaStream
            ? videoPreview.srcObject
            : new MediaStream();
        stream.getTracks().forEach((existing) => {
          if (existing.id !== state.videoTrack?.id) {
            stream.removeTrack(existing);
          }
        });
        if (
          state.videoTrack &&
          !stream.getVideoTracks().some((t) => t.id === state.videoTrack?.id)
        ) {
          stream.addTrack(state.videoTrack);
        }
        if (videoPreview.srcObject !== stream) {
          videoPreview.srcObject = stream;
        }
        updatePreviewSize();
      } else {
        videoPreview.style.display = "none";
        videoPreview.srcObject = null;
        previewSizeBadge.textContent = "";
        previewSizeBadge.style.display = "none";
      }

      if (state.audioTrack) {
        audioMeterEl.style.display = "block";
        audioMeter.start(state.audioTrack);
      } else {
        audioMeterEl.style.display = "none";
        audioMeter.stop();
      }
    };
    roomInput.addEventListener("input", render);
    this.setIdentity = (peerId: string) => {
      state.identityAssigned = true;
      state.peerId = peerId;
      render();
    };
    this.setRoomAttached = (room: string) => {
      state.joined = true;
      roomInput.value = room;
      render();
    };
    this.setRoomDetached = () => {
      state.joined = false;
      state.uplinkReady = false;
      render();
    };
    this.setUplinkReady = (ready: boolean) => {
      state.uplinkReady = ready;
      render();
    };
    this.setSignalingState = (connected: boolean) => {
      state.signalingConnected = connected;
      render();
    };
    this.setLocalMediaOpened = (
      kind: "audio" | "video",
      track: MediaStreamTrack,
      _appData: AppData | undefined,
    ) => {
      if (kind === "audio") {
        state.audioTrack = track;
      }
      if (kind === "video") {
        state.videoTrack = track;
      }
      render();
    };
    this.setLocalMediaClosed = (
      kind: "audio" | "video",
      _appData: AppData | undefined,
    ) => {
      if (kind === "audio") {
        state.audioTrack = undefined;
      }
      if (kind === "video") {
        state.videoTrack = undefined;
      }
      render();
    };
    this.setHandlers = (nextHandlers: LocalMediaPanelHandlers) => {
      handlers = nextHandlers;
    };

    audioRow.toggleBtn.onclick = () => {
      if (!state.joined || !state.signalingConnected) {
        return;
      }
      handlers.onToggleAudio?.();
    };
    videoRow.toggleBtn.onclick = () => {
      if (!state.joined || !state.signalingConnected) {
        return;
      }
      handlers.onToggleVideo?.();
    };
    roomToggle.onclick = () => {
      if (!state.identityAssigned) {
        throw new Error("Cannot attach room before identity is assigned");
      }
      if (state.joined) {
        handlers.onLeaveRoom?.();
        return;
      }
      const roomName = roomInput.value.trim();
      if (!roomName) {
        throw new Error("Room name is required to attach a room");
      }
      handlers.onJoinRoom?.(roomName);
    };

    render();
  }

  /**
   * Attach the uplink panel to a parent container.
   */
  mount(parent: HTMLElement = document.body) {
    parent.appendChild(this.panel);
  }
}
