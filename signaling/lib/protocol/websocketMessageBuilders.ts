import type {
  DtlsParameters,
  IceCandidate,
  IceParameters,
  SctpParameters,
} from "mediasoup/types";

import type { Guid } from "../../../types/baseTypes.d.ts";
import type { WsMessageMap } from "./signalingIoValidation.js";

/**
 * Websocket-focused message constructors.
 *
 * Keep websocket response shaping isolated from netsocket request payload
 * construction to make protocol boundaries easier to reason about.
 */

export type WebRTCTransportDetails = {
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
};

/** Flattened websocket payload shape for transport details responses. */
export type TransportDetailsMessage = {
  transportId: Guid;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
  sctpParameters?: SctpParameters;
};

/**
 * Flattens internal transport details into websocket transport-details payload.
 *
 * @param transportId Signaling transport id.
 * @param details Internal transport detail object.
 * @returns Typed transport-details payload.
 */
export const buildTransportDetailsMessage = (
  transportId: Guid,
  details: WebRTCTransportDetails,
): TransportDetailsMessage => ({
  transportId,
  iceParameters: details.iceParameters,
  iceCandidates: details.iceCandidates,
  dtlsParameters: details.dtlsParameters,
  sctpParameters: details.sctpParameters,
});

/**
 * Creates websocket `createdEgress` payload from transport details + egress id.
 *
 * @param details Transport details payload.
 * @param egressServer Selected egress server id.
 * @returns Typed `createdEgress` payload.
 */
export const buildCreatedEgressMessage = (
  details: TransportDetailsMessage,
  egressServer: Guid,
): WsMessageMap["createdEgress"] => ({
  transportId: details.transportId,
  iceParameters: details.iceParameters,
  iceCandidates: details.iceCandidates,
  dtlsParameters: details.dtlsParameters,
  sctpParameters: details.sctpParameters,
  egressServer,
});
