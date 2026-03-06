/**
 * @module mediasoupSessionController
 * @file MediasoupSessionController is the UI-facing entry point for signaling + media.
 *
 * MediasoupSessionController presents a small, stable API to UI code. It centralizes the
 * mediasoup-client (browser) sequencing and translates it into clear method
 * calls and deterministic events, while keeping server-side mediasoup concerns
 * (routers/transports on the media server) abstracted behind signaling.
 *
 * Responsibilities:
 * - Signaling lifecycle (connect, attach/detach room) between UI and server.
 * - Media lifecycle (capture, produce, consume) in the browser via
 *   mediasoup-client.
 * - Transport status (ingress/egress/signaling) as simple booleans for UI.
 *
 * Why it matters:
 * - WebRTC and mediasoup have strict ordering requirements.
 * - UI should not track low-level transport details.
 * - The controller only emits events after state changes are real and complete.
 *
 * Example:
 * ```ts
 * import { MediasoupSessionController } from "./controllers/mediasoupSessionController";
 *
 * const controller = new MediasoupSessionController("ws://localhost:8080");
 *
 * controller.on("identityAssigned", (selfId) => {
 *   console.log("self", selfId);
 *   controller.attachRoom("demo");
 * });
 * controller.on("roomAttached", () => {
 *   controller.toggleMicrophone();
 *   controller.toggleWebcam();
 * });
 * controller.on("peerConnected", (peerId, room) => {
 *   console.log("peer joined", peerId, room);
 * });
 * controller.on("peerMediaOpened", (peerId, kind, track, appData) => {
 *   console.log("remote", kind, appData, track);
 * });
 *
 * controller.connectSignaling();
 * ```
 */
import type {
  MediasoupSessionControllerState,
  MediasoupSessionControllerStateAction,
} from "./mediasoupSessionControllerState";
import {
  initialMediasoupSessionControllerState,
  reduceMediasoupSessionControllerState,
} from "./mediasoupSessionControllerState";
import { traceController } from "./trace";
import { mediaSignaling as MediaSignaling } from "../signaling/mediaSignaling";
import type { AppData } from "mediasoup-client/lib/types";
import type { SystemStatus } from "../../../types/wsRelay";

/**
 * Event name → handler signature map for the controller.
 *
 * - The controller is a thin boundary between **real network/media state** and UI.
 * - Events report **facts that already happened** (not intentions).
 * - Events are **edge‑triggered** and not replayed unless the underlying state
 *   changes again.
 * - The controller does **not** retry or recover; you see exactly what the system
 *   observes.
 *
 * Use these to drive UI truthfully. If an event does not fire, assume that
 * state did not change.
 *
 * @category Implementer API
 */
export type MediasoupSessionControllerEventMap = {
  /**
   * Assigned peer id for this session.
   * This is the moment the server confirms "you are X", and UI can safely
   * show local identity safely.
   */
  identityAssigned: (selfId: string) => void;
  /**
   * WebRTC ingress transport status (local → server).
   * `true` means the producer transport is connected and can send.
   * `false` means no media can be produced, regardless of local capture.
   */
  transportIngressStatus: (isConnected: boolean) => void;
  /**
   * WebRTC ingress transport readiness (created in browser, not necessarily connected).
   * `true` means the transport exists and can be used to start producing media.
   */
  transportIngressReady: (ready: boolean) => void;
  /**
   * WebRTC egress transport status (server → local).
   * `true` means at least one egress transport is connected.
   * Use this to gate “receiving” UI, not just signaling.
   */
  transportEgressStatus: (isConnected: boolean) => void;
  /**
   * Remote peer opened media. `appData` is forwarded from the producer if set.
   * Fired when a remote producer is consumable and a track exists.
   */
  peerMediaOpened: (
    peerId: string,
    kind: "audio" | "video",
    track: MediaStreamTrack,
    appData: AppData | undefined,
  ) => void;
  /**
   * Local media opened. `appData` is forwarded from the producer if set.
   * Fired when local capture is active and producer creation succeeded.
   */
  localMediaOpened: (
    kind: "audio" | "video",
    track: MediaStreamTrack,
    appData: AppData | undefined,
  ) => void;
  /**
   * Local media closed. `appData` is forwarded from the producer if set.
   * This means the local producer/track is no longer sending.
   */
  localMediaClosed: (
    kind: "audio" | "video",
    appData: AppData | undefined,
  ) => void;
  /**
   * Remote peer media closed. `appData` is forwarded from the producer if set.
   * Use this to stop rendering and clear indicators for that source.
   */
  peerMediaClosed: (
    peerId: string,
    kind: "audio" | "video",
    appData: AppData | undefined,
  ) => void;
  /**
   * Peer disconnected from the room (or lost signaling).
   * This is a definitive signal to remove peer UI and clean up client state.
   */
  peerDisconnected: (peerId: string, room?: string) => void;
  /**
   * Peer connected to the room. Fired for peers already in the room when you join.
   * Treat this as a roster/awareness event (not media‑ready yet).
   */
  peerConnected: (peerId: string, room: string) => void;
  /**
   * Local peer attached to a room (membership active).
   * At this point you can request/produce media for that room.
   */
  roomAttached: (room: string) => void;
  /**
   * Local peer detached from a room (membership ended).
   * Use this to clear local media UI and room-specific state.
   */
  roomDetached: (room: string) => void;
  /**
   * Full system status snapshot from signaling (servers/routers/loads).
   * This is the “truth” used by the status diagram and diagnostics.
   */
  systemStatus: (data: SystemStatus) => void;
  /**
   * Signaling websocket status. `true` means the socket is open.
   * This is the prerequisite for all other signaling-driven actions.
   */
  transportSignalingStatus: (isConnected: boolean) => void;
};

/**
 * Unsubscribe callback for removing event handlers.
 * @category Implementer API
 */
/** @hidden */
/**
 * Single UI-facing controller surface.
 *
 * This class is the only thing a UI should talk to directly. It wraps
 * signaling + mediasoup details and exposes a small, explicit command API
 * plus a typed event map for everything the UI needs to know.
 *
 * Design rules:
 * - The controller never retries or heals state; it only reports facts.
 * - Commands are explicit (connect, attach, toggle) so intent is clear.
 * - Events are edge-triggered; if they do not fire, state did not change.
 *
 * @category Implementer API
 */
export class MediasoupSessionController {
  private adapter = new MediaSignaling();
  private handlers = new Map<
    keyof MediasoupSessionControllerEventMap,
    Set<
      MediasoupSessionControllerEventMap[keyof MediasoupSessionControllerEventMap]
    >
  >();
  private state: MediasoupSessionControllerState;

  /**
   * Create a new MediasoupSessionController bound to a signaling endpoint.
   *
   * This does not connect immediately; call `connectSignaling()` when
   * the UI is ready. The constructor wires adapter events to controller
   * events and seeds internal state for gating commands.
   */
  constructor(signalingUrl: string) {
    this.adapter.signalingUrl = signalingUrl;
    this.state = initialMediasoupSessionControllerState({
      room: this.adapter.room,
      signalingConnected: this.adapter.signalingConnected,
      signalingUrl,
      peerId: this.adapter.peerId || undefined,
    });

    this.adapter.identityHandler = (selfId) => {
      this.traceEvent("identityAssigned", { peerId: selfId });
      this.apply({ type: "IDENTITY", peerId: selfId });
      this.emit("identityAssigned", selfId);
    };
    this.adapter.transportIngressStatusHandler = (isConnected) => {
      this.traceEvent("transportIngressStatus", { connected: isConnected });
      this.emit("transportIngressStatus", isConnected);
    };
    this.adapter.transportIngressReadyHandler = (ready) => {
      this.traceEvent("transportIngressReady", { ready });
      this.emit("transportIngressReady", ready);
    };
    this.adapter.transportEgressStatusHandler = (isConnected) => {
      this.traceEvent("transportEgressStatus", { connected: isConnected });
      this.emit("transportEgressStatus", isConnected);
    };
    this.adapter.peerVideoHandler = (peerId, track, appData) => {
      this.traceEvent("peerMediaOpened", { peerId, kind: "video" });
      this.emit("peerMediaOpened", peerId, "video", track, appData);
    };
    this.adapter.peerAudioHandler = (peerId, track, appData) => {
      this.traceEvent("peerMediaOpened", { peerId, kind: "audio" });
      this.emit("peerMediaOpened", peerId, "audio", track, appData);
    };
    this.adapter.peerScreenVideoHandler = (peerId, track, appData) => {
      this.traceEvent("peerMediaOpened", { peerId, kind: "video" });
      this.emit("peerMediaOpened", peerId, "video", track, appData);
    };
    this.adapter.peerScreenAudioHandler = (peerId, track, appData) => {
      this.traceEvent("peerMediaOpened", { peerId, kind: "audio" });
      this.emit("peerMediaOpened", peerId, "audio", track, appData);
    };
    this.adapter.localAudioHandler = (track, appData) => {
      this.traceEvent("localMediaOpened", { kind: "audio" });
      this.emit("localMediaOpened", "audio", track, appData);
    };
    this.adapter.localVideoHandler = (track, appData) => {
      this.traceEvent("localMediaOpened", { kind: "video" });
      this.emit("localMediaOpened", "video", track, appData);
    };
    this.adapter.localMediaClosedHandler = (kind, appData) => {
      this.traceEvent("localMediaClosed", { kind });
      this.emit("localMediaClosed", kind, appData);
    };
    this.adapter.peerMediaClosedHandler = (peerId, kind, appData) => {
      this.traceEvent("peerMediaClosed", { peerId, kind });
      this.emit("peerMediaClosed", peerId, kind, appData);
    };
    this.adapter.peerDisconnectedHandler = (peerId, room) => {
      this.traceEvent("peerDisconnected", { peerId, room });
      this.emit("peerDisconnected", peerId, room);
    };
    this.adapter.peerConnectedHandler = (peerId, room) => {
      this.traceEvent("peerConnected", { peerId, room });
      this.emit("peerConnected", peerId, room);
    };
    this.adapter.roomAttachedHandler = (peerId, room) => {
      this.traceEvent("roomAttached", { peerId, room });
      this.apply({ type: "ROOM_ATTACHED", room });
      this.emit("roomAttached", room);
    };
    this.adapter.roomDetachedHandler = (peerId, room) => {
      this.traceEvent("roomDetached", { peerId, room });
      this.apply({ type: "ROOM_DETACHED", room });
      this.emit("roomDetached", room);
    };
    this.adapter.systemStatusHandler = (data: SystemStatus) => {
      this.emit("systemStatus", data);
    };
    this.adapter.transportSignalingStatusHandler = (isConnected: boolean) => {
      this.traceEvent("transportSignalingStatus", { connected: isConnected });
      this.apply({
        type: "SIGNALING_STATE",
        connected: isConnected,
        url: this.adapter.signalingUrl,
      });
      this.emit("transportSignalingStatus", isConnected);
    };
  }

  /**
   * Open the signaling websocket.
   *
   * Signaling is the coordination channel: it is how the client discovers
   * rooms, transports, and media producers. Without signaling, no WebRTC
   * transport can be created, and the controller will not emit room/media events.
   *
   * In other terms: signaling is the “introduction + agreement” path that
   * lets peers align on how they will communicate.
   * @group Signaling
   */
  connectSignaling = (url?: string) => {
    this.traceAction("SIGNALING_CONNECT");
    const targetUrl =
      url ?? this.state.signalingUrl ?? this.adapter.signalingUrl ?? undefined;
    if (!targetUrl) {
      return;
    }
    this.adapter.signalingUrl = targetUrl;
    this.apply({
      type: "SIGNALING_STATE",
      connected: this.state.signalingConnected,
      url: targetUrl,
    });
    this.adapter.connect(targetUrl);
  };

   /**
    * Close the signaling websocket.
    *
    * This explicitly ends the coordination channel. Existing WebRTC media
    * transports may continue to flow, but no new peers will be discovered and
    * room navigation will not work.
    * @group Signaling
    */
  disconnectSignaling = () => {
    this.traceAction("SIGNALING_DISCONNECT");
    this.adapter.disconnect();
  };

  /**
   * Attach this peer to a room.
   *
   * In other systems this is often called “join” or “enter”.
   * Attaching means you are now present in a shared space where other
   * peers may already exist and new peers may arrive.
   *
   * @group Signaling
   */
  attachRoom = (room?: string) => {
    this.traceAction("ROOM_ATTACH");
    if (!this.state.peerId) {
      throw new Error("Cannot attach room before identity is assigned.");
    }
    const roomName = room || this.adapter.room || "demo";
    this.adapter.enterRoom(roomName);
  };

  /**
   * Detach this peer from its current room.
   *
   * In other systems this is often called “leave” or “exit”.
   * Detaching means you are no longer present in that shared space.
   *
   * @group Signaling
   */
  detachRoom = () => {
    this.traceAction("ROOM_DETACH");
    const roomName = this.adapter.room || this.state.room;
    if (!roomName) {
      throw new Error("Cannot detach room before it is attached.");
    }
    this.adapter.disconnectUplink();
    this.adapter.leaveRoom(roomName);
  };

  /**
   * Toggle local audio (microphone) sending.
   * @group Media
   */
  /**
   * Toggle local microphone sending.
   * @group Media
   */
  toggleMicrophone = () => {
    this.traceAction("TOGGLE_MICROPHONE");
    if (!this.state.signalingConnected || !this.state.joined) {
      throw new Error("Cannot toggle microphone before signaling + room attach.");
    }
    this.adapter.toggleAudio();
  };

  /**
   * Toggle local webcam sending.
   * @group Media
   */
  toggleWebcam = () => {
    this.traceAction("TOGGLE_WEBCAM");
    if (!this.state.signalingConnected || !this.state.joined) {
      throw new Error("Cannot toggle webcam before signaling + room attach.");
    }
    this.adapter.toggleVideo();
  };

  /**
   * Ask a remote peer to mute/unmute themselves client-side.
   * @group Signaling
   */
  requestPeerClientMute = (peerId: string, muted: boolean) => {
    this.traceAction("REQUEST_PEER_CLIENT_MUTE");
    if (!this.state.signalingConnected || !this.state.peerId) {
      throw new Error("Cannot request peer mute before signaling + identity.");
    }
    this.adapter.requestPeerMute(
      this.state.peerId,
      peerId,
      "client",
      muted,
    );
  };

  /**
   * Mute/unmute a remote peer at the server level.
   * @group Signaling
   */
  requestPeerServerMute = (peerId: string, muted: boolean) => {
    this.traceAction("REQUEST_PEER_SERVER_MUTE");
    if (!this.state.signalingConnected || !this.state.peerId) {
      throw new Error("Cannot request server mute before signaling + identity.");
    }
    this.adapter.requestPeerMute(
      this.state.peerId,
      peerId,
      "server",
      muted,
    );
  };

  /**
   * Placeholder for screen sharing.
   * @group Media
   */
  toggleScreenShare = () => {
    throw new Error("Screen sharing is not wired yet.");
  };

  /**
   * Register a handler for a controller event.
   * Returns an unsubscribe function to remove the handler later.
   *
   * This is the single entrypoint for UI → controller wiring.
   * Each call adds one handler; multiple handlers per event are supported.
   * Handlers fire in registration order.
   *
   * @typeParam K - Event name key from {@link MediasoupSessionControllerEventMap}.
   * @param event - Event name to subscribe to.
   * @param handler - Callback to run when the event fires.
   * @returns Unsubscribe function to remove this handler.
   * @group Events
   */
  on = <K extends keyof MediasoupSessionControllerEventMap>(
    event: K,
    handler: MediasoupSessionControllerEventMap[K],
  ): (() => void) => {
    const set = this.getHandlers(event);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  };

  private apply = (action: MediasoupSessionControllerStateAction) => {
    this.state = reduceMediasoupSessionControllerState(this.state, action);
  };

  private getHandlers = <
    K extends keyof MediasoupSessionControllerEventMap,
  >(
    event: K,
  ) => {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    return this.handlers.get(event) as Set<
      MediasoupSessionControllerEventMap[K]
    >;
  };

  private emit = <K extends keyof MediasoupSessionControllerEventMap>(
    event: K,
    ...args: Parameters<MediasoupSessionControllerEventMap[K]>
  ) => {
    const set = this.getHandlers(event);
    for (const handler of set) {
      (
        handler as (
          ...params: Parameters<MediasoupSessionControllerEventMap[K]>
        ) => void
      )(
        ...args,
      );
    }
  };

  private traceAction = (action: string) => {
    traceController("action", {
      action,
      room: this.state.room,
      peerId: this.state.peerId,
      signalingConnected: this.state.signalingConnected,
      joined: this.state.joined,
    });
  };

  private traceEvent = (event: string, detail: Record<string, unknown>) => {
    traceController("event", { event, ...detail });
  };
}
