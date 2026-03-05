/**
 * Mediasoup transport helpers for ingress/egress setup and hook wiring.
 * Separated so transport construction stays reusable and testable.
 */
import type { Device } from "mediasoup-client";
import type {
  DtlsParameters,
  IceCandidate,
  IceParameters,
} from "mediasoup-client/lib/Transport";
import type { Transport } from "mediasoup-client/lib/types";
import type {
  CreatedEgress,
  CreatedIngress,
  RequestMessage as UserRequestMessage,
} from "../../../types/wsRelay";
import type { IceHandler } from "../controllers/mediasoupSessionControllerEvents";

/** @internal @category Internals */
export type SendTransportHooks = {
  send: (message: UserRequestMessage) => void;
  peerId: string;
  room: string;
  iceHandler: IceHandler;
  nextRequestId: () => string;
  storeProduceCallback: (requestId: string, callback: (data: { id: string }) => void) => void;
  onStateChange: (state: string) => void;
};

/** @internal @category Internals */
export type RecvTransportHooks = {
  send: (message: UserRequestMessage) => void;
  peerId: string;
  room: string;
  iceHandler: IceHandler;
  onStateChange: (state: string) => void;
  serverId: string;
};

/** @internal @category Internals */
export async function createIngressTransport(
  device: Device,
  transport: CreatedIngress,
  hooks: SendTransportHooks,
): Promise<Transport> {
  const iceServers = (await hooks.iceHandler?.()) || new Array();
  const sendTransport = device.createSendTransport({
    id: transport.transportId,
    iceParameters: transport.iceParameters as IceParameters,
    iceCandidates: transport.iceCandidates as IceCandidate[],
    iceServers,
    dtlsParameters: transport.dtlsParameters as DtlsParameters,
    sctpParameters: transport.sctpParameters,
  });

  sendTransport.on("connect", async ({ dtlsParameters }, callback) => {
    const message: UserRequestMessage = {
      type: "connectIngress",
      message: {
        peerId: hooks.peerId,
        transportId: sendTransport.id,
        room: hooks.room,
        dtlsParameters,
      },
    };
    hooks.send(message);
    callback();
  });

  sendTransport.on("produce", async ({ kind, rtpParameters, appData }, callback) => {
    const requestId = hooks.nextRequestId();
    hooks.storeProduceCallback(requestId, callback);
    const message: UserRequestMessage = {
      type: "produceMedia",
      message: {
        producingPeer: hooks.peerId,
        transportId: sendTransport.id,
        producerOptions: {
          kind,
          rtpParameters,
          appData,
        },
        requestId,
      },
    };
    hooks.send(message);
  });

  sendTransport.on("connectionstatechange", (state) => {
    hooks.onStateChange(state);
  });

  return sendTransport;
}

/** @internal @category Internals */
export async function createEgressTransport(
  device: Device,
  transport: CreatedEgress,
  hooks: RecvTransportHooks,
): Promise<Transport> {
  const iceServers = (await hooks.iceHandler?.()) || new Array();
  const recvTransport = device.createRecvTransport({
    id: transport.transportId,
    iceParameters: transport.iceParameters as IceParameters,
    iceCandidates: transport.iceCandidates as IceCandidate[],
    iceServers,
    dtlsParameters: transport.dtlsParameters as DtlsParameters,
    sctpParameters: transport.sctpParameters,
  });

  recvTransport.on("connect", async ({ dtlsParameters }, callback) => {
    const message: UserRequestMessage = {
      type: "connectEgress",
      message: {
        peerId: hooks.peerId,
        transportId: recvTransport.id,
        room: hooks.room,
        dtlsParameters,
        serverId: hooks.serverId,
      },
    };
    hooks.send(message);
    callback();
  });

  recvTransport.on("connectionstatechange", (state) => {
    hooks.onStateChange(state);
  });

  return recvTransport;
}
