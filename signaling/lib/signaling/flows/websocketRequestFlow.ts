/**
 * Websocket protocol dispatch table for user-originated signaling requests.
 *
 * This module enforces:
 * - websocket ownership/actor guards,
 * - policy gates (admission, room media, transport, rate limit),
 * - routing to domain services that own behavior.
 *
 * @remarks
 * ```mermaid
 * flowchart TD
 *   IN[ws request] --> RL[rate-limit gate]
 *   RL --> G[ownership guards]
 *   G --> H[handler group by concern]
 *   H --> CORE[core peer/room/media actions]
 * ```
 */
import type { Guid } from "../../../../types/baseTypes.d.ts";
import type { RequestMessage as UserRequestMessage } from "../../../../types/wsRelay.d.ts";
import type { Peer as PeerLifecycle } from "../../core/peer/peer.js";
import type { PeerExtendedControl } from "../../core/peer/peerExtendedControl.js";
import type { PeerMediaSession } from "../../core/peer/peerMediaSession.js";
import type { PeerSessions } from "../../core/peer/peerSessions.js";
import { requirePeerIdByOrigin as requirePeerIdByOriginState } from "../../core/peer/peerStateMachine.js";
import type { PeerWebRTCTransport } from "../../core/peer/peerWebRTCTransport.js";
import type { Room } from "../../core/room/room.js";
import type { MediaServerRegistry } from "../../core/mediaServer/serverRegistry.js";
import type { WebSocketServer } from "../../listeners/websocketServer.js";
import type { StatusReporter } from "../../observability/statusReporter.js";
import type { WsRequestMap } from "../../protocol/signalingIoValidation.js";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import { buildWebsocketErrorMessage } from "../../protocol/websocketResponseBuilders.js";
import type { SignalingPolicies } from "../policies/types.js";

/** Callback signature used by ownership-guard helpers after actor resolution. */
type ExecuteWithActor = (actorPeerId: Guid) => Promise<void> | void;
/** Union of all websocket request discriminator values. */
type WsRequestType = UserRequestMessage["type"];
/** Request type narrowed to one discriminator for handler dispatch. */
type TypedWsRequest<T extends WsRequestType> = {
  type: T;
  message: WsRequestMap[T];
};
/** Per-message websocket dispatch handler signature. */
type WsRequestHandler<T extends WsRequestType> = (
  typedSignal: TypedWsRequest<T>,
) => Promise<void> | void;
/** Dispatch table keyed by websocket request type discriminator. */
type WsRequestHandlers = {
  [K in WsRequestType]: WsRequestHandler<K>;
};

/**
 * Explicit websocket request router for human-readable protocol flow.
 *
 * Keeps runtime dispatch linear and searchable while still delegating
 * per-message behavior to typed handlers.
 */
const dispatchWebsocketRequest = async (params: {
  signal: UserRequestMessage;
  handlers: WsRequestHandlers;
}) => {
  const { signal, handlers } = params;
  switch (signal.type) {
    case "requestIdentity":
      return handlers.requestIdentity(signal);
    case "disconnectPeerWebsocket":
      return handlers.disconnectPeerWebsocket(signal);
    case "joinRoom":
      return handlers.joinRoom(signal);
    case "leaveRoom":
      return handlers.leaveRoom(signal);
    case "mutePeer":
      return handlers.mutePeer(signal);
    case "createIngress":
      return handlers.createIngress(signal);
    case "createEgress":
      return handlers.createEgress(signal);
    case "connectIngress":
      return handlers.connectIngress(signal);
    case "connectEgress":
      return handlers.connectEgress(signal);
    case "produceMedia":
      return handlers.produceMedia(signal);
    case "requestRoomAudio":
      return handlers.requestRoomAudio(signal);
    case "requestRoomVideo":
      return handlers.requestRoomVideo(signal);
    case "producerClose":
      return handlers.producerClose(signal);
    case "requestSystemStatus":
      return handlers.requestSystemStatus(signal);
    default: {
      const unreachableSignal: never = signal;
      return unreachableSignal;
    }
  }
};

/**
 * Runtime dependencies required by websocket request dispatch.
 *
 * This structure represents orchestration ports only; network listener details
 * remain in `websocketIngressFlow`.
 */
export type WebsocketRequestFlowContext = {
  policies: SignalingPolicies;
  sessions: PeerSessions;
  serverRegistry: MediaServerRegistry;
  peerLifecycle: PeerLifecycle;
  peerExtendedControl: PeerExtendedControl;
  peerWebRTCTransport: PeerWebRTCTransport;
  peerMediaSession: PeerMediaSession;
  room: Room;
  websocketServer: WebSocketServer;
  statusReporter: StatusReporter;
  sendWebsocketMessage: SignalingMessenger["sendWebsocketMessage"];
  rejectedWebSocketRequest: (message: string) => never;
};

/**
 * Builds peer identity/ownership guards scoped to one websocket session.
 *
 * Every inbound request must prove that the acting websocket owns the peer ids
 * present in the payload before mutating room/transport/media state.
 *
 * @param params Websocket session + dependencies used by guard checks.
 * @returns Ownership guard helper functions bound to `wsid`.
 */
const createWebsocketRequestGuards = (params: {
  wsid: Guid;
  sessions: PeerSessions;
  rejectedWebSocketRequest: (message: string) => never;
}) => {
  const { wsid, sessions, rejectedWebSocketRequest } = params;

  /**
   * Resolves actor peer id for current websocket or throws rejection.
   *
   * @param messageType - Incoming websocket message type.
   * @returns Actor peer id bound to `wsid`.
   * @throws {Error} Via `rejectedWebSocketRequest` when websocket is not peer-identified.
   */
  const requireActorPeerId = (messageType: WsRequestType): Guid => {
    const actorPeerId = sessions.getPeerIdByOrigin(wsid);
    if (actorPeerId === undefined) {
      rejectedWebSocketRequest(
        `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${messageType}, reason=request requires an identified peer`,
      );
    }
    return actorPeerId as Guid;
  };

  /**
   * Verifies that actor peer id matches referenced peer id from payload.
   *
   * @param ownership - Actor/referenced peer ownership tuple.
   * @returns `void`.
   * @throws {Error} Via `rejectedWebSocketRequest` on ownership mismatch.
   */
  const requireOwnedPeer = (ownership: {
    actorPeerId: Guid;
    referencedPeerId: Guid;
    fieldName: string;
    messageType: WsRequestType;
  }) => {
    const { actorPeerId, referencedPeerId, fieldName, messageType } = ownership;
    if (actorPeerId !== referencedPeerId) {
      rejectedWebSocketRequest(
        `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${messageType}, reason=peer ownership mismatch, actorPeerId=${actorPeerId}, ${fieldName}=${referencedPeerId}`,
      );
    }
  };

  /**
   * Resolves actor id and verifies ownership for one referenced peer field.
   *
   * @param ownership - Referenced peer ownership descriptor.
   * @returns Actor peer id after ownership verification.
   */
  const requireActorOwnedPeer = (ownership: {
    referencedPeerId: Guid;
    fieldName: string;
    messageType: WsRequestType;
  }) => {
    const actorPeerId = requireActorPeerId(ownership.messageType);
    requireOwnedPeer({
      actorPeerId,
      referencedPeerId: ownership.referencedPeerId,
      fieldName: ownership.fieldName,
      messageType: ownership.messageType,
    });
    return actorPeerId;
  };

  /**
   * Executes callback after ownership verification and actor id resolution.
   *
   * @param ownership - Ownership descriptor plus callback.
   * @returns Callback result.
   */
  const withActorOwnedPeer = (ownership: {
    referencedPeerId: Guid;
    fieldName: string;
    messageType: WsRequestType;
    execute: ExecuteWithActor;
  }) => {
    const actorPeerId = requireActorOwnedPeer({
      referencedPeerId: ownership.referencedPeerId,
      fieldName: ownership.fieldName,
      messageType: ownership.messageType,
    });
    return ownership.execute(actorPeerId);
  };

  /** Rewrites `message.peerId` with actor id after ownership verification. */
  const withOwnedPeerIdForwarder = <
    T extends { type: WsRequestType; message: { peerId: Guid } },
  >(forwarding: {
    typedSignal: T;
    forward: (message: T["message"]) => Promise<void> | void;
  }) =>
    withActorOwnedPeer({
      referencedPeerId: forwarding.typedSignal.message.peerId,
      fieldName: "peerId",
      messageType: forwarding.typedSignal.type,
      execute: (actorPeerId) =>
        forwarding.forward({
          ...forwarding.typedSignal.message,
          peerId: actorPeerId,
        }),
    });

  /** Rewrites `message.requestingPeer` with actor id after ownership verification. */
  const withOwnedRequester = <
    T extends {
      type: WsRequestType;
      message: { requestingPeer: Guid };
    },
  >(forwarding: {
    typedSignal: T;
    forward: (message: T["message"]) => Promise<void> | void;
  }) =>
    withActorOwnedPeer({
      referencedPeerId: forwarding.typedSignal.message.requestingPeer,
      fieldName: "requestingPeer",
      messageType: forwarding.typedSignal.type,
      execute: (actorPeerId) =>
        forwarding.forward({
          ...forwarding.typedSignal.message,
          requestingPeer: actorPeerId,
        }),
    });

  return {
    requireActorPeerId,
    withActorOwnedPeer,
    withOwnedPeerIdForwarder,
    withOwnedRequester,
  };
};

/**
 * Builds one request-handler table scoped to a websocket origin.
 *
 * Keeping this table in a standalone helper makes the request-flow method read as
 * a short orchestration pipeline: rate-limit -> guards -> handler dispatch.
 */
const buildWebsocketRequestHandlers = (params: {
  wsid: Guid;
  context: WebsocketRequestFlowContext;
  guards: ReturnType<typeof createWebsocketRequestGuards>;
}): WsRequestHandlers => {
  const { wsid, context, guards } = params;
  const {
    policies,
    sessions,
    serverRegistry,
    peerLifecycle,
    peerExtendedControl,
    peerWebRTCTransport,
    peerMediaSession,
    room,
    websocketServer,
    statusReporter,
    sendWebsocketMessage,
    rejectedWebSocketRequest,
  } = context;
  const {
    requireActorPeerId,
    withActorOwnedPeer,
    withOwnedPeerIdForwarder,
    withOwnedRequester,
  } = guards;

  const identitySessionHandlers: Pick<
    WsRequestHandlers,
    "requestIdentity" | "disconnectPeerWebsocket"
  > = {
    requestIdentity: (typedSignal: TypedWsRequest<"requestIdentity">) => {
      const admissionDecision = policies.admission.validateIdentityRegion({
        region: typedSignal.message.region,
        hasRegion: (region) => serverRegistry.hasRegion(region),
      });
      if (!admissionDecision.allowed) {
        sendWebsocketMessage(
          wsid,
          "error",
          buildWebsocketErrorMessage(
            admissionDecision.error,
            admissionDecision.detail,
          ),
        );
        return;
      }
      peerLifecycle.createPeer(wsid, typedSignal.message.region);
    },
    disconnectPeerWebsocket: (
      typedSignal: TypedWsRequest<"disconnectPeerWebsocket">,
    ) => {
      if (typedSignal.message.transport !== wsid) {
        rejectedWebSocketRequest(
          `disconnectPeerWebsocket blocked: wsid=${wsid}, requestedTransport=${typedSignal.message.transport}, reason=request can only close its own websocket`,
        );
      }
      websocketServer.close(wsid, typedSignal.message.code);
    },
  };

  const roomControlHandlers: Pick<
    WsRequestHandlers,
    "joinRoom" | "leaveRoom" | "mutePeer"
  > = {
    joinRoom: (typedSignal: TypedWsRequest<"joinRoom">) =>
      withActorOwnedPeer({
        referencedPeerId: typedSignal.message.peerId,
        fieldName: "peerId",
        messageType: typedSignal.type,
        execute: (actorPeerId) =>
          peerLifecycle.joinRoom(actorPeerId, typedSignal.message.room),
      }),
    leaveRoom: (typedSignal: TypedWsRequest<"leaveRoom">) =>
      withActorOwnedPeer({
        referencedPeerId: typedSignal.message.peerId,
        fieldName: "peerId",
        messageType: typedSignal.type,
        execute: (actorPeerId) =>
          peerLifecycle.leaveRoom(actorPeerId, typedSignal.message.room),
      }),
    mutePeer: (typedSignal: TypedWsRequest<"mutePeer">) =>
      withOwnedRequester({
        typedSignal,
        forward: (message) => {
          peerExtendedControl.mutePeer(message);
        },
      }),
  };

  const transportHandlers: Pick<
    WsRequestHandlers,
    "createIngress" | "createEgress" | "connectIngress" | "connectEgress"
  > = {
    createIngress: (typedSignal: TypedWsRequest<"createIngress">) =>
      withOwnedPeerIdForwarder({
        typedSignal,
        forward: (message) => {
          if (
            !policies.webRTCTransport.allowIngressTransportAction({
              actorPeerId: message.peerId,
              action: "create",
            })
          ) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=WebRTC transport policy rejected ingress create`,
            );
          }
          peerWebRTCTransport.createIngressTransport(
            message.peerId,
            message.room,
            message.numStreams,
            message.rtpCapabilities,
          );
        },
      }),
    createEgress: (typedSignal: TypedWsRequest<"createEgress">) =>
      withOwnedPeerIdForwarder({
        typedSignal,
        forward: (message) => {
          if (
            !policies.webRTCTransport.allowEgressTransportAction({
              actorPeerId: message.peerId,
              action: "create",
            })
          ) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=WebRTC transport policy rejected egress create`,
            );
          }
          peerWebRTCTransport.createEgressTransport(
            message.peerId,
            message.room,
            message.numStreams,
            message.rtpCapabilities,
            message.serverId,
          );
        },
      }),
    connectIngress: (typedSignal: TypedWsRequest<"connectIngress">) =>
      withOwnedPeerIdForwarder({
        typedSignal,
        forward: (message) => {
          if (
            !policies.webRTCTransport.allowIngressTransportAction({
              actorPeerId: message.peerId,
              action: "connect",
            })
          ) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=WebRTC transport policy rejected ingress connect`,
            );
          }
          peerWebRTCTransport.connectPeerTransport(
            message.peerId,
            message.transportId,
            "ingress",
            message.dtlsParameters,
          );
        },
      }),
    connectEgress: (typedSignal: TypedWsRequest<"connectEgress">) =>
      withOwnedPeerIdForwarder({
        typedSignal,
        forward: (message) => {
          if (
            !policies.webRTCTransport.allowEgressTransportAction({
              actorPeerId: message.peerId,
              action: "connect",
            })
          ) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=WebRTC transport policy rejected egress connect`,
            );
          }
          peerWebRTCTransport.connectPeerTransport(
            message.peerId,
            message.transportId,
            "egress",
            message.dtlsParameters,
            message.serverId,
          );
        },
      }),
  };

  const mediaHandlers: Pick<
    WsRequestHandlers,
    "produceMedia" | "requestRoomAudio" | "requestRoomVideo" | "producerClose"
  > = {
    produceMedia: (typedSignal: TypedWsRequest<"produceMedia">) =>
      withActorOwnedPeer({
        referencedPeerId: typedSignal.message.producingPeer,
        fieldName: "producingPeer",
        messageType: typedSignal.type,
        execute: (actorPeerId) => {
          const produceMessage = {
            ...typedSignal.message,
            producingPeer: actorPeerId,
          };
          const mediaKind = peerMediaSession.resolveProducerMediaKind(
            produceMessage.producerOptions.kind,
            typedSignal.type,
          );
          const allowUpload =
            mediaKind === "audio"
              ? policies.roomMedia.allowRoomAudioUpload({ actorPeerId })
              : policies.roomMedia.allowRoomVideoUpload({ actorPeerId });
          if (!allowUpload) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=room media policy rejected upload request`,
            );
          }
          if (!room.ensureRoomEgressReady(actorPeerId, "produceMedia")) {
            return;
          }
          peerMediaSession.createProducer(
            produceMessage.producingPeer,
            produceMessage.transportId,
            produceMessage.producerOptions,
            produceMessage.requestId,
          );
        },
      }),
    requestRoomAudio: (typedSignal: TypedWsRequest<"requestRoomAudio">) =>
      withOwnedRequester({
        typedSignal,
        forward: (message) => {
          if (
            !policies.roomMedia.allowRoomAudioRequest({
              actorPeerId: message.requestingPeer,
            })
          ) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=request room media policy rejected request`,
            );
          }
          peerMediaSession.requestRoomMedia({
            requestingPeerId: message.requestingPeer,
            mediaType: "audio",
            context: "requestRoomAudio",
          });
        },
      }),
    requestRoomVideo: (typedSignal: TypedWsRequest<"requestRoomVideo">) =>
      withOwnedRequester({
        typedSignal,
        forward: (message) => {
          if (
            !policies.roomMedia.allowRoomVideoRequest({
              actorPeerId: message.requestingPeer,
            })
          ) {
            rejectedWebSocketRequest(
              `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=request room media policy rejected request`,
            );
          }
          peerMediaSession.requestRoomMedia({
            requestingPeerId: message.requestingPeer,
            mediaType: "video",
            context: "requestRoomVideo",
          });
        },
      }),
    producerClose: (typedSignal: TypedWsRequest<"producerClose">) => {
      requireActorPeerId(typedSignal.type);
      if (typedSignal.message.originId !== wsid) {
        rejectedWebSocketRequest(
          `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${typedSignal.type}, reason=origin mismatch, originId=${typedSignal.message.originId}`,
        );
      }
      const peerId = requirePeerIdByOriginState({
        sessions,
        originId: typedSignal.message.originId as Guid,
        context: "producerClose",
      });
      peerMediaSession.requestProducerClose(
        peerId,
        typedSignal.message.producerId,
        typedSignal.message.mediaType,
      );
    },
  };

  const statusHandlers: Pick<WsRequestHandlers, "requestSystemStatus"> = {
    requestSystemStatus: (
      _typedSignal: TypedWsRequest<"requestSystemStatus">,
    ) => {
      if (websocketServer.getStatusSubscriberCount() > 0) {
        statusReporter.start();
      }
    },
  };

  return {
    ...identitySessionHandlers,
    ...roomControlHandlers,
    ...transportHandlers,
    ...mediaHandlers,
    ...statusHandlers,
  };
};

/**
 * Stateful request flow for validated websocket user requests.
 */
export class WebsocketRequestFlow {
  private readonly context: WebsocketRequestFlowContext;

  /**
   * Captures dispatch dependencies for one signaling runtime instance.
   *
   * @param context - Websocket request-flow dependencies.
   */
  constructor(context: WebsocketRequestFlowContext) {
    this.context = context;
  }

  /**
   * Applies global request-rate policy for one websocket request.
   *
   * @param wsid Origin websocket id.
   * @param messageType Request discriminator.
   * @returns `void`.
   * @throws {Error} When the rate policy denies request execution.
   */
  private enforceRateLimit(wsid: Guid, messageType: WsRequestType) {
    const rateLimitDecision =
      this.context.policies.rateLimit.allowWebSocketRequest({
        wsid,
        messageType,
        nowMs: Date.now(),
      });
    if (!rateLimitDecision.allowed) {
      this.context.rejectedWebSocketRequest(
        `incomingWebsocketSignal blocked: wsid=${wsid}, messageType=${messageType}, reason=${rateLimitDecision.detail}`,
      );
    }
  }

  /**
   * Routes one websocket request through policy + ownership guards.
   *
   * Execution order:
   * 1) global websocket rate-limit gate,
   * 2) actor ownership guards per message type,
   * 3) message-specific policy/domain action.
   *
   * @param params Dispatch inputs (`wsid`, typed request payload).
   * @throws {Error} Propagates domain errors so caller can map to protocol reply.
   */
  async dispatch(params: { wsid: Guid; signal: UserRequestMessage }) {
    const { wsid, signal } = params;
    this.enforceRateLimit(wsid, signal.type);

    const {
      requireActorPeerId,
      withActorOwnedPeer,
      withOwnedPeerIdForwarder,
      withOwnedRequester,
    } = createWebsocketRequestGuards({
      wsid,
      sessions: this.context.sessions,
      rejectedWebSocketRequest: this.context.rejectedWebSocketRequest,
    });

    const handlers = buildWebsocketRequestHandlers({
      wsid,
      context: this.context,
      guards: {
        requireActorPeerId,
        withActorOwnedPeer,
        withOwnedPeerIdForwarder,
        withOwnedRequester,
      },
    });

    await dispatchWebsocketRequest({
      signal,
      handlers,
    });
  }
}
