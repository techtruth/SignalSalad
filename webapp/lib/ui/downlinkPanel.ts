/**
 * Downlink panel UI: renders remote peer media cards and attaches tracks.
 * Separated so media rendering is decoupled from controller and signaling state.
 */
import type { AudioMeter } from "./audioMeter";
import { createAudioMeter } from "./audioMeter";
import * as feather from "feather-icons";

/** @category Architecture */
export type PeerCard = {
  container: HTMLDivElement;
  videoWrapper: HTMLDivElement;
  videoPlaceholder: HTMLDivElement;
  videoEl?: HTMLVideoElement;
  audioEl?: HTMLAudioElement;
  clientMuteBtn: HTMLButtonElement;
  serverMuteBtn: HTMLButtonElement;
  clientMuted: boolean;
  serverMuted: boolean;
  audioDot: HTMLSpanElement;
  videoDot: HTMLSpanElement;
  audioLabel: HTMLSpanElement;
  videoLabel: HTMLSpanElement;
  audioMeter: HTMLDivElement;
  audioLevel: HTMLDivElement;
  meter: AudioMeter;
  videoSize?: {
    width: number;
    height: number;
  };
};

/** Callback hooks for mute actions initiated from peer cards. */
export type DownlinkPanelHandlers = {
  onRequestClientMute?: (peerId: string, muted: boolean) => void;
  onRequestServerMute?: (peerId: string, muted: boolean) => void;
};

const shortId = (id: string) => id.split("-")[0];
const createActionIconMarkup = (iconName: "mic-off" | "server") => {
  const icons = (feather as { icons?: Record<string, { toSvg: (opts: Record<string, unknown>) => string }> }).icons;
  const icon = icons ? icons[iconName] : undefined;
  if (!icon) {
    throw new Error(`Missing feather icon ${iconName}`);
  }
  return icon.toSvg({
    width: 12,
    height: 12,
    "stroke-width": 1.7,
    class: "peer-action-icon",
  });
};

const applyActionIcon = (
  button: HTMLButtonElement,
  iconName: "mic-off" | "server",
) => {
  const markup = createActionIconMarkup(iconName);
  const svgDoc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const svgEl = svgDoc.documentElement;
  button.replaceChildren(svgEl);
};

const createVideoPlaceholderSvg = () => {
  const markup = `
    <svg viewBox="0 0 320 180" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="No video">
      <defs>
        <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="#1a1f2a" />
          <stop offset="100%" stop-color="#10131a" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="320" height="180" rx="12" fill="url(#bg)" />
      <rect x="20" y="20" width="280" height="140" rx="10" fill="#151a23" stroke="#2a3140" />
      <polygon points="140,72 140,108 172,90" fill="#5d6b82" />
      <circle cx="160" cy="90" r="36" fill="none" stroke="#2a3140" stroke-width="2" />
      <text x="160" y="144" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="12" fill="#8793a8">waiting for video</text>
    </svg>
  `;
  const svgDoc = new DOMParser().parseFromString(markup, "image/svg+xml");
  return svgDoc.documentElement;
};

/**
 * Downlink panel implementation for remote media cards.
 * @category Architecture
 */
export class DownlinkPanel {
  panel: HTMLDivElement;
  peerList: HTMLDivElement;
  peers: Map<string, PeerCard>;
  linkDot: HTMLSpanElement;
  outputMuted: boolean;
  private handlers: DownlinkPanelHandlers;

  constructor() {
    this.panel = document.createElement("div");
    this.panel.className = "media-status-panel downlink-panel";
    this.peers = new Map();
    this.outputMuted = false;
    this.handlers = {};

    const headerBar = document.createElement("div");
    headerBar.className = "panel-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "panel-title-wrap";
    const headerTitle = document.createElement("span");
    headerTitle.className = "panel-title";
    headerTitle.textContent = "Downlink";
    this.linkDot = document.createElement("span");
    this.linkDot.className = "status-dot";
    this.linkDot.title = "downlink";
    titleWrap.appendChild(headerTitle);
    titleWrap.appendChild(this.linkDot);

    headerBar.appendChild(titleWrap);
    this.panel.appendChild(headerBar);

    this.peerList = document.createElement("div");
    this.peerList.className = "peer-list";
    this.panel.appendChild(this.peerList);

    this.updateLinkState();
  }

  /**
   * Attach the downlink panel to a parent container.
   */
  mount(parent: HTMLElement = document.body) {
    parent.appendChild(this.panel);
  }

  /**
   * Attach or update a remote video track for a peer card.
   */
  attachVideo(peerId: string, track: MediaStreamTrack) {
    const card = this.ensurePeerCard(peerId);
    this.showVideoWrapper(card);
    card.videoPlaceholder.style.display = "flex";
    const videoEl = this.ensureVideoElement(card);
    const stream = this.ensureVideoStream(videoEl);
    this.replaceVideoTrack(stream, track);
    const activate = () => this.setVideoActive(card);
    const deactivate = () => this.setVideoInactive(card);
    track.onunmute = activate;
    track.onmute = deactivate;
    track.onended = deactivate;
    if (track.muted) {
      deactivate();
    } else {
      activate();
    }
    this.updateLinkState();
  }

  /**
   * Ensure a peer card exists even before media arrives.
   */
  addPeer(peerId: string) {
    this.ensurePeerCard(peerId);
  }

  /**
   * Attach or update a remote audio track for a peer card.
   */
  attachAudio(peerId: string, track: MediaStreamTrack) {
    const card = this.ensurePeerCard(peerId);
    const audioEl = this.ensureAudioElement(card);
    audioEl.muted = this.outputMuted;
    this.replaceAudioTrack(audioEl, track);
    this.clearClientMuteRequest(card);
    const activate = () => this.setAudioActive(card, track);
    const deactivate = () => this.setAudioInactive(card);
    track.onunmute = activate;
    track.onmute = deactivate;
    track.onended = deactivate;
    if (track.muted) {
      deactivate();
    } else {
      activate();
    }
    this.updateLinkState();
  }

  /**
   * Clear any remote audio state for a peer.
   */
  setAudioOff(peerId: string) {
    const card = this.peers.get(peerId);
    if (!card) return;
    this.clearAudio(card);
    this.updateLinkState();
  }

  /**
   * Clear any remote video state for a peer.
   */
  setVideoOff(peerId: string) {
    const card = this.peers.get(peerId);
    if (!card) return;
    this.clearVideo(card);
    this.updateLinkState();
  }

  /**
   * Remove a peer card and all associated media.
   */
  removePeer(peerId: string) {
    const card = this.peers.get(peerId);
    if (!card) return;
    this.clearAudio(card);
    this.clearVideo(card);
    card.container.remove();
    this.peers.delete(peerId);
    this.updateLinkState();
  }

  /**
   * Remove all peer cards and associated media.
   */
  clearPeers() {
    for (const card of this.peers.values()) {
      this.clearAudio(card);
      this.clearVideo(card);
      card.container.remove();
    }
    this.peers.clear();
    this.updateLinkState();
  }

  /**
   * Mutes or unmutes all rendered downlink audio elements locally.
   *
   * @param muted - Local output mute state.
   * @returns `void`.
   */
  setOutputMuted(muted: boolean) {
    this.outputMuted = muted;
    for (const card of this.peers.values()) {
      if (card.audioEl) {
        card.audioEl.muted = muted;
      }
    }
  }

  /**
   * Replaces peer-card action handlers.
   *
   * @param handlers - New downlink panel handlers.
   * @returns `void`.
   */
  setHandlers(handlers: DownlinkPanelHandlers) {
    this.handlers = handlers;
  }

  private ensurePeerCard(peerId: string): PeerCard {
    const existing = this.peers.get(peerId);
    if (existing) return existing;

    const container = document.createElement("div");
    container.className = "peer-card";

    const header = document.createElement("div");
    header.className = "peer-card-header";
    const peerLabel = document.createElement("span");
    peerLabel.className = "peer-id";
    peerLabel.textContent = `Peer ${shortId(peerId)}`;
    const actions = document.createElement("div");
    actions.className = "peer-actions";
    const clientMuteBtn = document.createElement("button");
    clientMuteBtn.type = "button";
    clientMuteBtn.className = "peer-action-btn";
    clientMuteBtn.textContent = "";
    clientMuteBtn.title = "Request this user to mute their microphone (client-side).";
    clientMuteBtn.setAttribute("aria-label", "request user mute");
    applyActionIcon(clientMuteBtn, "mic-off");
    const serverMuteBtn = document.createElement("button");
    serverMuteBtn.type = "button";
    serverMuteBtn.className = "peer-action-btn";
    serverMuteBtn.textContent = "";
    serverMuteBtn.title = "Mute this user at the server (forces audio off).";
    serverMuteBtn.setAttribute("aria-label", "server mute");
    applyActionIcon(serverMuteBtn, "server");
    actions.appendChild(clientMuteBtn);
    actions.appendChild(serverMuteBtn);
    header.appendChild(peerLabel);
    header.appendChild(actions);
    container.appendChild(header);

    const statusRow = document.createElement("div");
    statusRow.className = "peer-status-row";
    const audioDot = document.createElement("span");
    audioDot.className = "status-dot";
    const audioLabel = document.createElement("span");
    audioLabel.className = "status-label";
    audioLabel.textContent = "audio";
    const videoDot = document.createElement("span");
    videoDot.className = "status-dot";
    const videoLabel = document.createElement("span");
    videoLabel.className = "status-label";
    videoLabel.textContent = "video";

    statusRow.appendChild(audioDot);
    statusRow.appendChild(audioLabel);
    statusRow.appendChild(videoDot);
    statusRow.appendChild(videoLabel);
    container.appendChild(statusRow);

    const audioMeter = document.createElement("div");
    audioMeter.className = "audio-meter";
    audioMeter.style.display = "none";
    const audioLevel = document.createElement("div");
    audioLevel.className = "audio-level";
    audioMeter.appendChild(audioLevel);
    container.appendChild(audioMeter);

    const videoWrapper = document.createElement("div");
    videoWrapper.className = "peer-video-wrap";
    videoWrapper.style.display = "none";
    const placeholder = document.createElement("div");
    placeholder.className = "peer-video-placeholder";
    placeholder.replaceChildren(createVideoPlaceholderSvg());
    videoWrapper.appendChild(placeholder);
    container.appendChild(videoWrapper);

    this.peerList.appendChild(container);
    const card: PeerCard = {
      container,
      videoWrapper,
      videoPlaceholder: placeholder,
      clientMuteBtn,
      serverMuteBtn,
      clientMuted: false,
      serverMuted: false,
      audioDot,
      videoDot,
      audioLabel,
      videoLabel,
      audioMeter,
      audioLevel,
      meter: createAudioMeter(audioLevel),
    };
    this.peers.set(peerId, card);
    this.bindPeerActions(peerId, card);
    this.updateLinkState();
    return card;
  }

  private bindPeerActions(peerId: string, card: PeerCard) {
    card.clientMuteBtn.addEventListener("click", () => {
      card.clientMuted = !card.clientMuted;
      card.clientMuteBtn.classList.toggle("is-muted", card.clientMuted);
      card.clientMuteBtn.title = card.clientMuted
        ? "Request this user to unmute their microphone (client-side)."
        : "Request this user to mute their microphone (client-side).";
      card.clientMuteBtn.setAttribute(
        "aria-pressed",
        card.clientMuted ? "true" : "false",
      );
      this.handlers.onRequestClientMute?.(peerId, card.clientMuted);
    });
    card.serverMuteBtn.addEventListener("click", () => {
      card.serverMuted = !card.serverMuted;
      card.serverMuteBtn.classList.toggle("is-muted", card.serverMuted);
      card.serverMuteBtn.title = card.serverMuted
        ? "Unmute this user at the server (restores audio)."
        : "Mute this user at the server (forces audio off).";
      card.serverMuteBtn.setAttribute(
        "aria-pressed",
        card.serverMuted ? "true" : "false",
      );
      this.handlers.onRequestServerMute?.(peerId, card.serverMuted);
    });
  }

  private clearClientMuteRequest(card: PeerCard) {
    if (!card.clientMuted) {
      return;
    }
    card.clientMuted = false;
    card.clientMuteBtn.classList.remove("is-muted");
    card.clientMuteBtn.title =
      "Request this user to mute their microphone (client-side).";
    card.clientMuteBtn.setAttribute("aria-pressed", "false");
  }

  private updateVideoLabel(card: PeerCard) {
    const base = "video";
    const size = card.videoSize;
    if (size) {
      card.videoLabel.textContent = `${base} (${size.width}x${size.height})`;
    } else {
      card.videoLabel.textContent = base;
    }
  }

  private showVideoWrapper(card: PeerCard) {
    card.videoWrapper.style.display = "block";
  }

  private ensureVideoElement(card: PeerCard) {
    if (card.videoEl) {
      return card.videoEl;
    }
    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // start muted to satisfy autoplay
    video.className = "peer-video";
    video.style.display = "none";
    card.videoEl = video;
    card.videoWrapper.appendChild(video);
    const showPlaceholder = () => {
      card.videoPlaceholder.style.display = "flex";
      video.style.display = "none";
    };
    const hidePlaceholder = () => {
      card.videoPlaceholder.style.display = "none";
      video.style.display = "block";
    };
    const updateSize = () => {
      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width > 0 && height > 0) {
        card.videoSize = { width, height };
        this.updateVideoLabel(card);
      }
    };
    video.addEventListener("loadedmetadata", updateSize);
    video.addEventListener("resize", updateSize);
    video.addEventListener("waiting", showPlaceholder);
    video.addEventListener("stalled", showPlaceholder);
    video.addEventListener("suspend", showPlaceholder);
    video.addEventListener("playing", hidePlaceholder);
    video.addEventListener("canplay", hidePlaceholder);
    return video;
  }

  private ensureVideoStream(videoEl: HTMLVideoElement) {
    if (videoEl.srcObject instanceof MediaStream) {
      return videoEl.srcObject;
    }
    const stream = new MediaStream();
    videoEl.srcObject = stream;
    return stream;
  }

  private replaceVideoTrack(stream: MediaStream, track: MediaStreamTrack) {
    const [currentTrack] = stream.getVideoTracks();
    if (currentTrack && currentTrack.id !== track.id) {
      stream.removeTrack(currentTrack);
      currentTrack.stop();
    }
    if (!stream.getVideoTracks().some((t) => t.id === track.id)) {
      stream.addTrack(track);
    }
  }

  private setVideoActive(card: PeerCard) {
    this.showVideoWrapper(card);
    if (card.videoEl) {
      card.videoEl.style.display = "block";
    }
    card.videoWrapper.classList.add("has-video");
    card.videoPlaceholder.style.display = "none";
    card.videoDot.classList.add("on");
    this.updateVideoLabel(card);
    this.playVideoSafe(card);
  }

  private setVideoInactive(card: PeerCard) {
    card.videoSize = undefined;
    if (card.videoEl) {
      card.videoEl.style.display = "none";
    }
    card.videoWrapper.style.display = "none";
    card.videoPlaceholder.style.display = "none";
    card.videoWrapper.classList.remove("has-video");
    card.videoDot.classList.remove("on");
    this.updateVideoLabel(card);
  }

  private clearVideo(card: PeerCard) {
    this.setVideoInactive(card);
    if (card.videoEl?.srcObject instanceof MediaStream) {
      card.videoEl.srcObject.getTracks().forEach((t) => t.stop());
    }
    if (card.videoEl) {
      card.videoEl.srcObject = null;
    }
  }

  private playVideoSafe(card: PeerCard) {
    if (!card.videoEl) return;
    const playPromise = card.videoEl.play();
    if (playPromise && typeof playPromise.catch === "function") {
      playPromise.catch((err) => {
        if (err?.name !== "AbortError") {
          console.warn("Downlink video autoplay blocked", err);
        }
      });
    }
  }

  private ensureAudioElement(card: PeerCard) {
    if (card.audioEl) {
      return card.audioEl;
    }
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.controls = false;
    audio.muted = this.outputMuted;
    audio.className = "peer-audio";
    card.audioEl = audio;
    card.container.appendChild(audio);
    return audio;
  }

  private replaceAudioTrack(audioEl: HTMLAudioElement, track: MediaStreamTrack) {
    if (audioEl.srcObject instanceof MediaStream) {
      audioEl.srcObject.getTracks().forEach((t) => t.stop());
    }
    audioEl.srcObject = new MediaStream([track]);
    audioEl.play().catch((err) =>
      console.warn("Downlink audio autoplay blocked", err),
    );
  }

  private setAudioActive(card: PeerCard, track: MediaStreamTrack) {
    card.audioDot.classList.add("on");
    card.audioLabel.textContent = "audio";
    card.audioMeter.style.display = "block";
    card.meter.start(track);
  }

  private setAudioInactive(card: PeerCard) {
    card.meter.stop();
    card.audioDot.classList.remove("on");
    card.audioLabel.textContent = "audio";
    card.audioMeter.style.display = "none";
  }

  private clearAudio(card: PeerCard) {
    if (card.audioEl?.srcObject instanceof MediaStream) {
      card.audioEl.srcObject.getTracks().forEach((t) => t.stop());
    }
    if (card.audioEl) {
      card.audioEl.srcObject = null;
    }
    this.setAudioInactive(card);
  }

  private updateLinkState() {
    const hasPeers = this.peers.size > 0;
    this.linkDot.classList.toggle("on", hasPeers);
    this.panel.classList.toggle("empty", !hasPeers);
  }

}
