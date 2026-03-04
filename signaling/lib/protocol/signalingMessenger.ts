import type { Guid } from "../../../types/baseTypes.d.ts";
import type { NsMessageMap, WsMessageMap } from "./signalingIoValidation.js";

/**
 * Minimal messaging abstraction used by lifecycle/coordinator modules.
 *
 * It allows core logic to emit typed websocket/netsocket messages without
 * importing transport-specific wiring concerns.
 */
export type SignalingMessenger = {
  sendWebsocketMessage<T extends keyof WsMessageMap>(
    wsid: Guid,
    type: T,
    message: WsMessageMap[T],
  ): void;
  sendNetsocketMessage<T extends keyof NsMessageMap>(
    destinationNode: Guid,
    channel: "ingress" | "egress",
    type: T,
    message: NsMessageMap[T],
  ): void;
};
