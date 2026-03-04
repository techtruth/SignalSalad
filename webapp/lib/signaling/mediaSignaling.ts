/**
 * Signaling adapter: translates WebSocket messages into mediasoup actions and events.
 * Internal to the controller so UI code stays decoupled from mediasoup details.
 */
import { Device } from "mediasoup-client";
import { Consumer } from "mediasoup-client/lib/Consumer";
import { Producer, Transport } from "mediasoup-client/lib/types";
import type { AppData } from "mediasoup-client/lib/types";
import type {
  IdentityHandler,
  IceHandler,
  UplinkStateHandler,
  UplinkReadyHandler,
  DownlinkStateHandler,
  PeerVideoHandler,
  PeerAudioHandler,
  PeerScreenVideoHandler,
  PeerScreenAudioHandler,
  PeerMediaClosedHandler,
  PeerDisconnectedHandler,
  SystemStatusHandler,
  LocalAudioHandler,
  LocalVideoHandler,
  LocalMediaClosedHandler,
  PeerConnectedHandler,
  RoomAttachedHandler,
  RoomDetachedHandler,
} from "../controllers/mediasoupSessionControllerEvents";

import type {
  ResponseMessage as UserResponseMessage,
  RequestMessage as UserRequestMessage,
  CreatedEgress,
  CreatedIngress,
} from "../../../types/wsRelay";
import { ConsumerRegistry } from "./consumerRegistry";
import { createEgressTransport, createIngressTransport } from "./mediaTransports";

/** @category Internals */
export class mediaSignaling {
  webRTCDevice: Device;
  peerId: string;
  originId: string; //Peer signaling transport ID
  room: string;

  //Local transports
  consumerTransport: { [transportId: string]: Transport };
  producerTransport: Transport | undefined;
  signalTransport: WebSocket | undefined;
  statusTransport: WebSocket | undefined;
  producerTransportConnected: boolean;
  consumerTransportConnected: boolean;
  signalingConnected: boolean;
  signalingUrl: string | undefined;
  ingressServerId: string | undefined;

  //Callback Functions
  identityHandler: IdentityHandler | undefined;
  iceHandler: IceHandler;
  transportIngressStatusHandler: UplinkStateHandler | undefined;
  transportIngressReadyHandler: UplinkReadyHandler | undefined;
  transportEgressStatusHandler: DownlinkStateHandler | undefined;
  peerVideoHandler: PeerVideoHandler | undefined;
  peerAudioHandler: PeerAudioHandler | undefined;
  peerScreenVideoHandler: PeerScreenVideoHandler | undefined;
  peerScreenAudioHandler: PeerScreenAudioHandler | undefined;
  peerMediaClosedHandler: PeerMediaClosedHandler | undefined;
  peerDisconnectedHandler: PeerDisconnectedHandler | undefined;
  peerConnectedHandler: PeerConnectedHandler | undefined;
  roomAttachedHandler: RoomAttachedHandler | undefined;
  roomDetachedHandler: RoomDetachedHandler | undefined;
  systemStatusHandler: SystemStatusHandler | undefined;
  localAudioHandler: LocalAudioHandler | undefined;
  localVideoHandler: LocalVideoHandler | undefined;
  localMediaClosedHandler: LocalMediaClosedHandler | undefined;
  transportSignalingStatusHandler: ((connected: boolean) => void) | undefined;

  //Local producers
  videoProducer: undefined | Producer;
  audioProducer: undefined | Producer;
  screenAudioProducer: undefined | Producer;
  screenVideoProducer: undefined | Producer;

  //Local producer ID
  videoProducerId: undefined | string;
  audioProducerId: undefined | string;
  screenVideoProducerId: undefined | string;
  screenAudioProducerId: undefined | string;

  //Local consumers
  private consumerRegistry: ConsumerRegistry;
  localTracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack };
  localAppData: { audio?: AppData; video?: AppData };
  pendingProduceRequests: Map<string, (data: { id: string }) => void>;
  consumerTransportStates: Map<string, boolean>;
  private requestedRoomMedia: boolean;
  private requestedEgressServers: Set<string>;
  private expectedEgressServers: Set<string>;
  private createdEgressServers: Set<string>;
  private roomEgressReady: boolean;
  private egressReadyPromise: Promise<void> | null;
  private resolveEgressReady: (() => void) | null;

  /**
   * Manages the client-side media and state of media.
   * This includes audio, video, screenAudio, and screenVideo in the room.
   * This component stands alone and will not require modificaton in your webapp.
   * If you would like your webapp to respond to media or other events, see the
   * MediasoupSessionController docs.
  **/
  constructor() {
    this.room = window.location.pathname.substring(1);

    //Transports
    this.consumerTransport = {};
    this.producerTransport = undefined;
    this.signalTransport = undefined;
    this.statusTransport = undefined;
    this.producerTransportConnected = false;
    this.consumerTransportConnected = false;
    this.signalingConnected = false;
    this.signalingUrl = undefined;
    this.ingressServerId = undefined;

    //Handlers
    this.identityHandler = undefined;
    this.iceHandler = async () => new Array();
    this.transportIngressStatusHandler = undefined;
    this.transportIngressReadyHandler = undefined;
    this.transportEgressStatusHandler = undefined;
    this.peerVideoHandler = undefined;
    this.peerAudioHandler = undefined;
    this.peerScreenVideoHandler = undefined;
    this.peerScreenAudioHandler = undefined;
    this.peerMediaClosedHandler = undefined;
    this.pendingProduceRequests = new Map();
    this.peerDisconnectedHandler = undefined;
    this.peerConnectedHandler = undefined;
    this.roomAttachedHandler = undefined;
    this.roomDetachedHandler = undefined;
    this.systemStatusHandler = undefined;
    this.localAudioHandler = undefined;
    this.localVideoHandler = undefined;
    this.localMediaClosedHandler = undefined;
    this.transportSignalingStatusHandler = undefined;

    // Local Producers
    this.videoProducer = undefined;
    this.audioProducer = undefined;
    this.screenVideoProducer = undefined;
    this.screenAudioProducer = undefined;

    // Local producer ID
    this.videoProducerId = undefined;
    this.audioProducerId = undefined;
    this.screenVideoProducerId = undefined;
    this.screenAudioProducerId = undefined;

    //Local consumers
    this.consumerRegistry = new ConsumerRegistry(
      () => this.peerMediaClosedHandler,
    );
    this.localTracks = {};
    this.localAppData = {};
    this.consumerTransportStates = new Map();
    this.requestedEgressServers = new Set();
    this.expectedEgressServers = new Set();
    this.createdEgressServers = new Set();
    this.roomEgressReady = false;
    this.resetRoomMediaState();
  }

  /**
   * Establish signaling connection to the api server via websocket
   * @param signalingURL - FQDN of the signaling server
   */
  connect(signalingURL: string) {
    this.signalingUrl = signalingURL;
    const signalingBaseUrl = this.resolveSignalingBaseUrl(signalingURL);
    if (this.signalTransport) {
      this.signalTransport.close();
      this.signalTransport = undefined;
    }
    if (this.statusTransport) {
      this.statusTransport.close();
      this.statusTransport = undefined;
    }
    const selectedRegion =
      new URL(location.href).searchParams.get("region") || "local";
    // Initialize websocket signal relay
    this.signalTransport = new WebSocket(
      this.buildChannelWebsocketUrl(signalingBaseUrl, "signaling"),
    );
    this.statusTransport = new WebSocket(
      this.buildChannelWebsocketUrl(signalingBaseUrl, "status"),
    );

    this.signalTransport.onclose = (event) => {
      console.error("Connection to signaling server closed", event);
      this.signalingConnected = false;
      this.transportSignalingStatusHandler?.(false);

      // When we reconnect, we reuse the existing avatar UUID
      if (!event.wasClean) {
        console.error(
          "Oops! Signaling connection was not cleanly closed!",
          event,
        );
      } else {
        console.warn("Signaling connection has closed cleanly.");
      }
    };
    this.signalTransport.onmessage = this.incomingSignal.bind(this);
    this.signalTransport.onopen = async () => {
      this.signalingConnected = true;
      this.transportSignalingStatusHandler?.(true);
      let message: UserRequestMessage = {
        type: "requestIdentity",
        message: {
          region: selectedRegion,
        },
      };
      this.send(message);
    };
    this.statusTransport.onmessage = this.incomingStatusSignal.bind(this);
    this.statusTransport.onclose = (event) => {
      console.warn("Connection to status websocket closed", event);
    };
    this.statusTransport.onerror = (event) => {
      console.error("Status websocket error", event);
    };

    // Initialize mediasoup device
    this.webRTCDevice = new Device();
  }

  /**
   * Closes signaling and status transports and updates signaling-connected state.
   *
   * @returns `void`.
   */
  disconnect() {
    if (this.signalTransport) {
      this.signalTransport.close();
      this.signalTransport = undefined;
    }
    if (this.statusTransport) {
      this.statusTransport.close();
      this.statusTransport = undefined;
    }
    if (this.signalingConnected) {
      this.signalingConnected = false;
      this.transportSignalingStatusHandler?.(false);
    }
  }

  private resolveSignalingBaseUrl(signalingURL: string) {
    const sanitized = signalingURL.trim().replace(/\/+$/, "");
    if (!sanitized) {
      throw new Error("Signaling URL cannot be empty");
    }
    const parsed = new URL(sanitized);
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, "/");
    parsed.pathname = parsed.pathname.replace(/\/(signaling|status)$/, "");
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString().replace(/\/+$/, "");
  }

  private buildChannelWebsocketUrl(
    signalingBaseUrl: string,
    channel: "signaling" | "status",
  ) {
    const parsed = new URL(signalingBaseUrl);
    const basePath = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = `${basePath}/${channel}`.replace(/\/{2,}/g, "/");
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }

  private incomingStatusSignal(message: { data: string }) {
    let signal: UserResponseMessage;
    try {
      signal = JSON.parse(message.data);
      if (signal.type === "systemStatus") {
        this.systemStatusHandler?.(signal.message);
        return;
      }
      if (signal.type === "error") {
        console.warn(
          "Status websocket error signal:",
          signal.message.error,
          signal.message.detail ?? "",
        );
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error("Can not JSON.parse status data", err, message);
      } else {
        console.error("Error handling status message", err, message);
      }
    }
  }

  /**
   * Requests ingress transport creation when client is ready to publish media.
   *
   * @returns `void`.
   */
  requestIngressTransport() {
    if (
      (this.producerTransport && !this.producerTransport.closed) ||
      !this.signalTransport ||
      this.signalTransport.readyState !== 1 ||
      !this.webRTCDevice.loaded ||
      !this.peerId ||
      !this.room ||
      !this.ingressServerId
    ) {
      return;
    }
    const ingressMessage: UserRequestMessage = {
      type: "createIngress",
      message: {
        peerId: this.peerId,
        room: this.room,
        numStreams: this.webRTCDevice.sctpCapabilities.numStreams,
        rtpCapabilities: this.webRTCDevice.rtpCapabilities,
        serverId: this.ingressServerId,
      },
    };
    this.send(ingressMessage);
  }

  /**
   * Tears down local uplink producers/transports and notifies signaling.
   *
   * @returns `void`.
   */
  disconnectUplink() {
    const hadAudio = this.localTracks.audio;
    const hadVideo = this.localTracks.video;
    if (this.audioProducer && this.originId) {
      this.send({
        type: "producerClose",
        message: {
          originId: this.originId,
          producerId: this.audioProducer.id,
          mediaType: "audio",
        },
      });
    }
    if (this.videoProducer && this.originId) {
      this.send({
        type: "producerClose",
        message: {
          originId: this.originId,
          producerId: this.videoProducer.id,
          mediaType: "video",
        },
      });
    }
    this.audioProducer?.close();
    this.videoProducer?.close();
    this.audioProducer = undefined;
    this.videoProducer = undefined;
    this.audioProducerId = undefined;
    this.videoProducerId = undefined;
    this.producerTransport?.close();
    this.producerTransport = undefined;
    this.producerTransportConnected = false;
    if (hadAudio) {
      const appData = this.localAppData.audio;
      if (appData === undefined) {
        throw new Error("Missing appData for local audio close");
      }
      this.localTracks.audio = undefined;
      this.localAppData.audio = undefined;
      hadAudio.onended = null;
      hadAudio.stop();
      this.localMediaClosedHandler?.("audio", appData);
    }
    if (hadVideo) {
      const appData = this.localAppData.video;
      if (appData === undefined) {
        throw new Error("Missing appData for local video close");
      }
      this.localTracks.video = undefined;
      this.localAppData.video = undefined;
      hadVideo.onended = null;
      hadVideo.stop();
      this.localMediaClosedHandler?.("video", appData);
    }
  }

  /**
   *  Join the room, but dont participate
   *  @public
   *  @param roomName - name of the room to join
   **/
  enterRoom(roomName: string) {
    this.room = roomName;
    this.resetRoomMediaState();
    let message: UserRequestMessage = {
      type: "joinRoom",
      message: {
        peerId: this.peerId,
        room: roomName,
      },
    };
    this.send(message);
  }

  /**
   * Leave a room by sending leaveRoom signal and closing local producers and consumers
   */
  leaveRoom(roomName: string) {
    const message: UserRequestMessage = {
      type: "leaveRoom",
      message: {
        peerId: this.peerId,
        room: roomName,
      },
    };
    this.send(message);
    this.ingressServerId = undefined;
    this.closeRoomTransports();
    this.resetRoomMediaState();
  }

  /**
   *  Start sending media, after entering room
   *  @note Must be called after enterRoom() is called
   *  @public
   **/
  async participate(sendMedia: boolean, recvMedia: boolean) {
    if (sendMedia) {
      // Check if getUserMedia is available
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        // Request access to the user's camera and microphone
        const stream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true,
        });
        // Get video and audio tracks from the stream
        const videoTrack = stream.getVideoTracks()[0];
        const audioTrack = stream.getAudioTracks()[0];
        this.addMedia({ audioTrack: audioTrack, videoTrack: videoTrack });
      } else {
        console.error("getUserMedia is not supported in this browser");
      }
    }

    if (recvMedia) {
      // Media requests will be sent once all egress transports are created.
    }
  }

  /**
   *  Add local media tracks, for relay to peers
   *  this sends data across the network to the media servers
   *   - if the media is undefined, do not act on it
   *   - if the media is false, remove it from sending
   *   - if the media is a track, add it to the sending
   *  @public
   *  @param mediaStreams - Streams returned by requestMedia() for sending to other remote peers
   **/
  async addMedia(mediaStreams: {
    audioTrack: MediaStreamTrack | false | undefined;
    videoTrack: MediaStreamTrack | false | undefined;
  }) {
    //If track is false, stop/remove it.
    //if track is undefined, take no action
    //if track is a track, add this track to the producer
    if (mediaStreams.audioTrack !== undefined) {
      if (mediaStreams.audioTrack === false) {
        if (this.audioProducer && this.originId) {
          this.send({
            type: "producerClose",
            message: {
              originId: this.originId,
              producerId: this.audioProducer.id,
              mediaType: "audio",
            },
          });
        }
        this.audioProducer?.close();
        this.audioProducer = undefined;
        this.audioProducerId = undefined;
        const previous = this.localTracks.audio;
        if (previous) {
          const appData = this.localAppData.audio;
          if (appData === undefined) {
            throw new Error("Missing appData for local audio close");
          }
          this.localTracks.audio = undefined;
          this.localAppData.audio = undefined;
          previous.onended = null;
          previous.stop();
          this.localMediaClosedHandler?.("audio", appData);
        }
      } else {
        const audioTrack = mediaStreams.audioTrack;
        const appData = {
          source: "microphone",
          deviceId: audioTrack.getSettings().deviceId,
        };
        this.localTracks.audio = audioTrack;
        this.localAppData.audio = appData;
        audioTrack.onended = () => {
          if (this.localTracks.audio?.id !== audioTrack.id) {
            return;
          }
          const closeData = this.localAppData.audio;
          if (closeData === undefined) {
            throw new Error("Missing appData for local audio close");
          }
          this.localTracks.audio = undefined;
          this.localAppData.audio = undefined;
          this.localMediaClosedHandler?.("audio", closeData);
        };
        this.localAudioHandler?.(audioTrack, appData);
        if (!this.webRTCDevice.canProduce("audio")) {
          console.warn("Device cannot produce audio");
          this.audioProducer = undefined;
        } else {
          try {
            this.audioProducer = await this.producerTransport.produce({
              track: audioTrack,
              appData,
            });
          } catch (err) {
            console.error("Failed to produce audio", err);
            this.audioProducer = undefined;
          }
        }
      }
    }

    if (mediaStreams.videoTrack !== undefined) {
      if (mediaStreams.videoTrack === false) {
        if (this.videoProducer && this.originId) {
          this.send({
            type: "producerClose",
            message: {
              originId: this.originId,
              producerId: this.videoProducer.id,
              mediaType: "video",
            },
          });
        }
        this.videoProducer?.close(); //Remove current producer
        this.videoProducer = undefined;
        this.videoProducerId = undefined;
        const previous = this.localTracks.video;
        if (previous) {
          const appData = this.localAppData.video;
          if (appData === undefined) {
            throw new Error("Missing appData for local video close");
          }
          this.localTracks.video = undefined;
          this.localAppData.video = undefined;
          previous.onended = null;
          previous.stop();
          this.localMediaClosedHandler?.("video", appData);
        }
      } else {
        const videoTrack = mediaStreams.videoTrack;
        const appData = {
          source: "webcam",
          deviceId: videoTrack.getSettings().deviceId,
        };
        this.localTracks.video = videoTrack;
        this.localAppData.video = appData;
        videoTrack.onended = () => {
          if (this.localTracks.video?.id !== videoTrack.id) {
            return;
          }
          const closeData = this.localAppData.video;
          if (closeData === undefined) {
            throw new Error("Missing appData for local video close");
          }
          this.localTracks.video = undefined;
          this.localAppData.video = undefined;
          this.localMediaClosedHandler?.("video", closeData);
        };
        this.localVideoHandler?.(videoTrack, appData);
        if (!this.webRTCDevice.canProduce("video")) {
          console.warn("Device cannot produce video");
          this.videoProducer = undefined;
        } else {
          try {
            this.videoProducer = await this.producerTransport.produce({
              track: videoTrack,
              appData,
            });
          } catch (err) {
            if ((err as any)?.sdp) {
              console.error("Produce error SDP", (err as any).sdp);
            }
            console.error("Failed to produce video", err);
            this.videoProducer = undefined;
          }
        }
      }
    }
    return;
  }

  async toggleAudio() {
    if (!this.roomEgressReady) {
      console.warn("Room egress not ready; cannot toggle audio.");
      return;
    }
    if (!this.producerTransport) {
      console.warn("Producer transport not ready; cannot toggle audio.");
      return;
    }
    if (this.localTracks.audio || this.audioProducer) {
      await this.addMedia({ audioTrack: false, videoTrack: undefined });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      const audioTrack = stream.getAudioTracks()[0];
      await this.addMedia({ audioTrack, videoTrack: undefined });
    } catch (err) {
      console.error("Failed to get audio track", err);
    }
  }

  async setAudioSendingEnabled(enabled: boolean) {
    const hasAudio = !!this.localTracks.audio || !!this.audioProducer;
    if (!enabled) {
      if (hasAudio) {
        await this.addMedia({ audioTrack: false, videoTrack: undefined });
      }
      return;
    }
    if (!this.producerTransport) {
      console.warn("Producer transport not ready; cannot enable audio.");
      return;
    }
    if (enabled && !hasAudio) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        const audioTrack = stream.getAudioTracks()[0];
        await this.addMedia({ audioTrack, videoTrack: undefined });
      } catch (err) {
        console.error("Failed to enable audio track", err);
      }
      return;
    }
  }

  async toggleVideo() {
    if (!this.roomEgressReady) {
      console.warn("Room egress not ready; cannot toggle video.");
      return;
    }
    if (!this.producerTransport) {
      console.warn("Producer transport not ready; cannot toggle video.");
      return;
    }
    if (this.localTracks.video || this.videoProducer) {
      await this.addMedia({ videoTrack: false, audioTrack: undefined });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
      });
      const videoTrack = stream.getVideoTracks()[0];
      await this.addMedia({ videoTrack, audioTrack: undefined });
    } catch (err) {
      console.error("Failed to get video track", err);
    }
  }

  /**
   * Sends a Websocket signaling message.
   * @param message - Payload of the message to deliver.
   */
  send(message: UserRequestMessage) {
    if (this.signalTransport && this.signalTransport.readyState === 1) {
      this.signalTransport.send(JSON.stringify(message));
    } else {
      console.error(
        "Signaling transport is undefined or closed, and can not send!",
      );
    }
  }

  /**
   * Sends a mute request for a target peer using client or server mute scope.
   *
   * @param requesterPeerId - Requesting peer id.
   * @param targetPeerId - Target peer id.
   * @param scope - Mute scope (`client` or `server`).
   * @param muted - Target mute state.
   * @returns `void`.
   */
  requestPeerMute(
    requesterPeerId: string,
    targetPeerId: string,
    scope: "client" | "server",
    muted: boolean,
  ) {
    const message: UserRequestMessage = {
      type: "mutePeer",
      message: {
        requestingPeer: requesterPeerId,
        targetPeer: targetPeerId,
        scope,
        muted,
      },
    };
    this.send(message);
  }

  private nextRequestId(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  private storeProduceCallback(
    requestId: string,
    callback: (data: { id: string }) => void,
  ) {
    if (this.pendingProduceRequests.has(requestId)) {
      console.warn("Duplicate produce requestId", requestId);
    }
    this.pendingProduceRequests.set(requestId, callback);
  }

  private resolveProduceCallback(requestId: string, producerId: string) {
    const pendingCallback = this.pendingProduceRequests.get(requestId);
    if (!pendingCallback) {
      console.warn("Missing pending produce callback for", requestId);
      return;
    }
    pendingCallback({ id: producerId });
    this.pendingProduceRequests.delete(requestId);
  }

  /**
   *  Takes incoming signals and invokes their payloads based on types.
   *  Determines the signal's type and then invokes functions
   *  Some of these may call the callback handlers
   *  @public
   *  @param {string} message - The incoming message signal
   **/
  async incomingSignal(message: { data: string }) {
    let signal: UserResponseMessage;
    try {
      const data = JSON.parse(message.data);
      signal = data;

      if (signal.type === "identity") {
        this.peerId = signal.message.peerId;
        this.originId = signal.message.originId;
        this.identityHandler?.(this.peerId);
      } else if (signal.type === "error") {
        const detail = signal.message.detail
          ? `: ${signal.message.detail}`
          : "";
        console.warn("Signaling error:", signal.message.error, detail);
        window.alert(`Signaling error: ${signal.message.error}${detail}`);
      } else if (signal.type === "joinedRoom") {
        this.room = signal.message.room;
        if (!this.webRTCDevice.loaded) {
          await this.webRTCDevice.load({
            routerRtpCapabilities: signal.message.roomRTPCapabilities,
          });
          // capabilities loaded; no verbose logging to avoid codec spam
        }

        //Request creating ingress transport
        if (signal.message.mode === "ingress") {
          if (this.ingressServerId) {
            throw new Error(
              `Protocol violation: duplicate joinedRoom ingress for room '${signal.message.room}'. existingServer=${this.ingressServerId}, incomingServer=${signal.message.serverId}`,
            );
          }
          this.ingressServerId = signal.message.serverId;
          this.requestIngressTransport();
        }

        //Request creating egress transport
        if (signal.message.mode === "egress") {
          if (this.requestedEgressServers.has(signal.message.serverId)) {
            throw new Error(
              `Protocol violation: duplicate joinedRoom egress for room '${signal.message.room}' on server ${signal.message.serverId}`,
            );
          }
          this.requestedEgressServers.add(signal.message.serverId);
          let egressMessage: UserRequestMessage = {
            type: "createEgress",
            message: {
              peerId: this.peerId,
              room: signal.message.room,
              numStreams: this.webRTCDevice.sctpCapabilities.numStreams,
              rtpCapabilities: this.webRTCDevice.rtpCapabilities,
              serverId: signal.message.serverId,
            },
          };
          this.send(egressMessage);
        }
      } else if (signal.type === "createdIngress") {
        this.connectIngressTransport(signal.message);
        this.transportIngressReadyHandler?.(true);
      } else if (signal.type === "createdEgress") {
        this.connectEgressTransport(signal.message);
        if (signal.message.egressServer) {
          this.createdEgressServers.add(signal.message.egressServer);
        }
        this.resolveEgressReadyIfPossible();
      } else if (signal.type === "connectedIngress") {
        //this.connectedIngressTransport(signal.message);
      } else if (signal.type === "connectedEgress") {
        // Media requests are sent after all egress transports are created.
      } else if (signal.type === "mediaAnnouncement") {
        //Unwrap object by producer peers,
        for (const consumerOptions of signal.message) {
          let newConsumer: Consumer;
          try {
            newConsumer = await this.consumerTransport[
              consumerOptions.transportId
            ].consume({
              id: consumerOptions.id,
              producerId: consumerOptions.producerId,
              kind: consumerOptions.kind,
              rtpParameters: consumerOptions.rtpParameters,
              streamId: consumerOptions.streamId,
              appData: consumerOptions.appData,
            });
            if (typeof newConsumer.resume === "function") {
              try {
                await newConsumer.resume();
              } catch (err) {
                console.warn("Failed to resume consumer", consumerOptions.id, err);
              }
            }
          } catch (e) {
            throw new TypeError(e.message);
          }
          if (newConsumer.kind === "audio") {
            this.peerAudioHandler?.(
              consumerOptions.producerPeerId,
              newConsumer.track,
              newConsumer.appData,
            );
          } else if (newConsumer.kind === "video") {
            this.peerVideoHandler?.(
              consumerOptions.producerPeerId,
              newConsumer.track,
              newConsumer.appData,
            );
          } else {
            console.warn(
              "Unknown media kind in media announcement",
              newConsumer.kind,
            );
          }
          this.consumerRegistry.addConsumer(
            newConsumer,
            consumerOptions.producerId,
            consumerOptions.producerPeerId,
          );
          newConsumer.on("trackended", () => {
            this.consumerRegistry.closeConsumersForProducer(
              consumerOptions.producerId,
              newConsumer.kind,
            );
          });
        }
      } else if (signal.type === "producedMedia") {
        const sourceKey =
          signal.message.appData &&
          typeof signal.message.appData.source === "string"
            ? signal.message.appData.source
            : undefined;
        if (!sourceKey) {
          console.warn("Produced media missing source appData", signal.message);
          return;
        }
        if (sourceKey === "microphone") {
          this.audioProducerId = signal.message.id;
        } else if (sourceKey === "webcam") {
          this.videoProducerId = signal.message.id;
        } else if (sourceKey === "screenVideo") {
          this.screenVideoProducerId = signal.message.id;
        } else if (sourceKey === "screenAudio") {
          this.screenAudioProducerId = signal.message.id;
        }
        if (signal.message.requestId) {
          this.resolveProduceCallback(
            signal.message.requestId,
            signal.message.id,
          );
        } else {
          console.warn("Produced media missing requestId", signal.message);
        }
      } else if (signal.type === "producerClosed") {
        this.consumerRegistry.ensureProducerPeer(
          signal.message.producerId,
          signal.message.originId,
        );
        const mediaType =
          signal.message.mediaType === "audio" ||
          signal.message.mediaType === "video"
            ? signal.message.mediaType
            : undefined;
        this.consumerRegistry.closeConsumersForProducer(
          signal.message.producerId,
          mediaType,
        );
      } else if (signal.type === "peerDisconnected") {
        this.consumerRegistry.closeConsumersForPeer(signal.message.peerId);
        this.peerDisconnectedHandler?.(
          signal.message.peerId,
          signal.message.room,
        );
      } else if (signal.type === "peerConnected") {
        this.peerConnectedHandler?.(signal.message.peerId, signal.message.room);
      } else if (signal.type === "roomAttached") {
        const attachedRoom = signal.message.room;
        this.room = attachedRoom;
        this.expectedEgressServers.clear();
        if (signal.message.egressServers) {
          signal.message.egressServers.forEach((serverId) => {
            this.expectedEgressServers.add(serverId);
          });
        }
        this.roomAttachedHandler?.(signal.message.peerId, attachedRoom);
        if (signal.message.roomPeers && signal.message.roomPeers.length) {
          signal.message.roomPeers.forEach((peerId) => {
            this.peerConnectedHandler?.(peerId, attachedRoom);
          });
        }
      } else if (signal.type === "roomEgressReady") {
        if (signal.message.room !== this.room) {
          return;
        }
        this.roomEgressReady = true;
        if (!this.requestedRoomMedia) {
          this.requestedRoomMedia = true;
          this.sendRoomMediaRequests();
        }
      } else if (signal.type === "roomDetached") {
        this.closeRoomTransports();
        this.transportIngressReadyHandler?.(false);
        this.roomEgressReady = false;
        this.roomDetachedHandler?.(
          signal.message.peerId,
          signal.message.room,
        );
      } else if (signal.type === "peerMuteRequested") {
        await this.setAudioSendingEnabled(!signal.message.muted);
      } else {
        console.warn("Got an unknown signal.", signal);
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.error("Can not JSON.parse data", err, message);
      } else {
        console.error("Error handling signaling message", err, message);
      }
    }
  }

  /**
   *  Creates a sending transport (ingress) from the client to the mediaserver.
   *  Setup the signals to send to the api when produce is called on this transport
   *  @public
   *  @param {Object} transport - Peer transport
   */
  async connectIngressTransport(transport: CreatedIngress) {
    //Create
    this.producerTransport = await createIngressTransport(
      this.webRTCDevice,
      transport,
      {
        send: this.send.bind(this),
        peerId: this.peerId,
        room: this.room,
        iceHandler: this.iceHandler,
        nextRequestId: this.nextRequestId.bind(this),
        storeProduceCallback: this.storeProduceCallback.bind(this),
        onStateChange: (state) => {
          if (this.producerTransport?.id !== transport.transportId) {
            return;
          }
          const connected = state === "connected";
          if (this.producerTransportConnected !== connected) {
            this.producerTransportConnected = connected;
            this.transportIngressStatusHandler?.(connected);
          }
          if (state === "failed") {
            console.error("Producer transport connection state FAILED");
          }
        },
      },
    );
  }

  /**
   *  Creates a receiving transport (egress) from the mediaserver to the client.
   *  Setup the actions to take when the transport connects
   *  Also setup actions to take on state change of transports
   *  @public
   *  @param {Object} transport - Peer transport
   */
  async connectEgressTransport(transport: CreatedEgress) {
    if (transport.egressServer) {
      this.consumerTransportStates.set(transport.egressServer, false);
    }
    this.consumerTransport[transport.transportId] =
      await createEgressTransport(this.webRTCDevice, transport, {
        send: this.send.bind(this),
        peerId: this.peerId,
        room: this.room,
        iceHandler: this.iceHandler,
        serverId: transport.egressServer,
        onStateChange: (connectionState) => {
          if (!this.consumerTransport[transport.transportId]) {
            return;
          }
          const connected = connectionState === "connected";
          if (transport.egressServer) {
            this.consumerTransportStates.set(transport.egressServer, connected);
          }
          const anyConnected = Array.from(
            this.consumerTransportStates.values(),
          ).some(Boolean);
          if (this.consumerTransportConnected !== anyConnected) {
            this.consumerTransportConnected = anyConnected;
            this.transportEgressStatusHandler?.(anyConnected);
          }
          if (connectionState === "failed") {
            console.error("Consumer transport connection state FAILED");
          }
        },
      });
  }

  private resetRoomMediaState() {
    this.ingressServerId = undefined;
    this.requestedRoomMedia = false;
    this.requestedEgressServers.clear();
    this.egressReadyPromise = null;
    this.resolveEgressReady = null;
    this.expectedEgressServers.clear();
    this.createdEgressServers.clear();
    this.roomEgressReady = false;
  }

  private closeRoomTransports() {
    if (this.audioProducer) {
      this.audioProducer.close();
      this.audioProducer = undefined;
      this.audioProducerId = undefined;
    }
    if (this.videoProducer) {
      this.videoProducer.close();
      this.videoProducer = undefined;
      this.videoProducerId = undefined;
    }
    if (this.screenAudioProducer) {
      this.screenAudioProducer.close();
      this.screenAudioProducer = undefined;
      this.screenAudioProducerId = undefined;
    }
    if (this.screenVideoProducer) {
      this.screenVideoProducer.close();
      this.screenVideoProducer = undefined;
      this.screenVideoProducerId = undefined;
    }
    const localAudio = this.localTracks.audio;
    if (localAudio) {
      const appData = this.localAppData.audio;
      if (appData === undefined) {
        throw new Error("Missing appData for local audio close");
      }
      this.localTracks.audio = undefined;
      this.localAppData.audio = undefined;
      localAudio.onended = null;
      localAudio.stop();
      this.localMediaClosedHandler?.("audio", appData);
    }
    const localVideo = this.localTracks.video;
    if (localVideo) {
      const appData = this.localAppData.video;
      if (appData === undefined) {
        throw new Error("Missing appData for local video close");
      }
      this.localTracks.video = undefined;
      this.localAppData.video = undefined;
      localVideo.onended = null;
      localVideo.stop();
      this.localMediaClosedHandler?.("video", appData);
    }
    Object.values(this.consumerTransport).forEach((transport) => {
      transport.close();
    });
    this.consumerTransport = {};
    this.consumerTransportStates.clear();
    if (this.consumerTransportConnected) {
      this.consumerTransportConnected = false;
      this.transportEgressStatusHandler?.(false);
    }
    this.consumerRegistry.closeAllConsumers();
    if (this.producerTransport) {
      this.producerTransport.close();
      this.producerTransport = undefined;
    }
    if (this.producerTransportConnected) {
      this.producerTransportConnected = false;
      this.transportIngressStatusHandler?.(false);
    }
  }

  private async waitForEgressReady() {
    if (!this.expectedEgressServers.size) {
      return;
    }
    if (!this.egressReadyPromise) {
      this.egressReadyPromise = new Promise((resolve) => {
        this.resolveEgressReady = resolve;
      });
    }
    // Resolve here to handle transports that are already created.
    this.resolveEgressReadyIfPossible();
    await this.egressReadyPromise;
  }

  private resolveEgressReadyIfPossible() {
    if (!this.resolveEgressReady) {
      return;
    }
    for (const serverId of this.expectedEgressServers) {
      if (!this.createdEgressServers.has(serverId)) {
        return;
      }
    }
    const resolve = this.resolveEgressReady;
    this.resolveEgressReady = null;
    this.egressReadyPromise = null;
    resolve();
  }

  private sendRoomMediaRequests() {
    this.send({
      type: "requestRoomAudio",
      message: {
        requestingPeer: this.peerId,
      },
    });
    this.send({
      type: "requestRoomVideo",
      message: {
        requestingPeer: this.peerId,
      },
    });
  }
}
