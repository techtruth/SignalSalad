import type { Guid } from "../../../../types/baseTypes.d.ts";
import { RecoverableNetsocketCommandError } from "../../protocol/netsocketCommandErrors.js";
import {
  buildConnectNetworkRelayMessage,
  buildFinalizeNetworkRelayMessage,
} from "../../protocol/netsocketMessageBuilders.js";
import type { SignalingMessenger } from "../../protocol/signalingMessenger.js";
import type {
  MediaInboundMessageMap,
  NsMessageMap,
} from "../../protocol/signalingIoValidation.js";
import type { MediaServerPipe } from "../../protocol/signalingTypes.js";

/** Pipe lookup key used to find existing ingress/egress relay transport mappings. */
export type PipeLookup = {
  ingress: Guid;
  egress: Guid;
  room: string;
  ingressPort: number;
  egressPort: number;
};

/** Pipe-registry API used to upsert ingress/egress relay transport mappings. */
export type RoomRelayPipeRegistryPort = {
  findPipe(params: PipeLookup): MediaServerPipe | undefined;
  addPipe(pipe: MediaServerPipe): void;
};

/** Server address lookup used to resolve relay endpoint IPs. */
export type RoomRelayServerAddressRegistryPort = {
  resolveRegisteredServerIp(
    serverId: Guid,
    mode: "ingress" | "egress",
  ): string | undefined;
};

/** Consumer payload planner used after relay finalize completes. */
export type RoomRelayConsumerPlannerPort = {
  createConsumerPayload(
    originId: Guid,
    producerId: string,
    kind: "video" | "audio",
    egressId: string,
  ): NsMessageMap["createConsumer"][];
};

/** Dependencies used by network relay handshake coordination. */
export type RoomRelayContext = {
  pipeRegistry: RoomRelayPipeRegistryPort;
  serverAddressRegistry: RoomRelayServerAddressRegistryPort;
  signalingMessenger: Pick<SignalingMessenger, "sendNetsocketMessage">;
  consumerPlanner: RoomRelayConsumerPlannerPort;
};

/**
 * Owns network relay handshake lifecycle between ingress and egress nodes.
 *
 * Responsibilities:
 * - resolve relay connect endpoints from registered media-server sockets
 * - persist pipe transport mappings
 * - trigger downstream create-consumer requests after relay finalize
 */
export class RoomRelay {
  private readonly context: RoomRelayContext;

  constructor(context: RoomRelayContext) {
    this.context = context;
  }

  private normalizeSocketIp(address: string) {
    if (address === "::1") {
      return "127.0.0.1";
    }
    if (address.startsWith("::ffff:")) {
      return address.slice(7);
    }
    const zoneIndex = address.indexOf("%");
    if (zoneIndex > -1) {
      return address.slice(0, zoneIndex);
    }
    return address;
  }

  private resolveRelayConnectIp(
    serverId: Guid,
    mode: "ingress" | "egress",
    context: string,
  ) {
    const socketAddress =
      this.context.serverAddressRegistry.resolveRegisteredServerIp(
        serverId,
        mode,
      );
    if (socketAddress) {
      return this.normalizeSocketIp(socketAddress);
    }
    throw new RecoverableNetsocketCommandError(
      "relayEndpointUnavailable",
      `${context}: cannot resolve relay IP for server ${serverId} (${mode})`,
    );
  }

  private upsertPipeTransport(
    ingress: Guid,
    egress: Guid,
    room: string,
    ingressPort: number,
    egressPort: number,
    producerId?: Guid,
  ) {
    const existing = this.context.pipeRegistry.findPipe({
      ingress,
      egress,
      room,
      ingressPort,
      egressPort,
    });
    if (existing) {
      if (producerId && !existing.producerIds.includes(producerId)) {
        existing.producerIds.push(producerId);
      }
      return;
    }

    const entry: MediaServerPipe = {
      ingress,
      egress,
      ingressPort,
      egressPort,
      room,
      producerIds: producerId ? [producerId] : [],
    };
    this.context.pipeRegistry.addPipe(entry);
  }

  /**
   * Handles ingress relay-init callbacks by requesting egress relay connect.
   *
   * @param serverId - Ingress server id that emitted the initialized relay callback.
   * @param message - Relay initialization payload.
   * @returns `void`.
   * @throws {RecoverableNetsocketCommandError} When relay endpoint IP cannot be resolved.
   */
  initializedNetworkRelay(
    serverId: Guid,
    message: MediaInboundMessageMap["initializedNetworkRelay"],
  ) {
    const ingressConnectIp = this.resolveRelayConnectIp(
      serverId,
      "ingress",
      "initializedNetworkRelay",
    );
    const relayMessage = buildConnectNetworkRelayMessage({
      originId: message.originId,
      producerId: message.producerId,
      routerNetwork: message.routerNetwork,
      consumerOptions: message.consumerOptions,
      createNetworkPipeTransport: message.createNetworkPipeTransport,
      ingressIp: ingressConnectIp,
      ingressPort: message.ingressPort,
      protocol: message.protocol,
      appData: message.appData,
      ingressServer: serverId,
    });
    this.context.signalingMessenger.sendNetsocketMessage(
      message.egressServer,
      "egress",
      "connectNetworkRelay",
      relayMessage,
    );
  }

  /**
   * Handles egress relay-connect callbacks by requesting ingress relay finalize.
   *
   * @param serverId - Egress server id that emitted the connected relay callback.
   * @param message - Relay connected payload.
   * @returns `void`.
   * @throws {RecoverableNetsocketCommandError} When relay endpoint IP cannot be resolved.
   */
  connectedNetworkRelay(
    serverId: Guid,
    message: MediaInboundMessageMap["connectedNetworkRelay"],
  ) {
    const egressConnectIp = this.resolveRelayConnectIp(
      serverId,
      "egress",
      "connectedNetworkRelay",
    );
    const relayMessage = buildFinalizeNetworkRelayMessage({
      originId: message.originId,
      routerNetwork: message.routerNetwork,
      producerId: message.producerId,
      connectedTransport: message.connectedTransport,
      egressIp: egressConnectIp,
      egressPort: message.egressPort,
      protocol: message.protocol,
      egressServer: serverId,
    });
    this.context.signalingMessenger.sendNetsocketMessage(
      message.ingressServer,
      "ingress",
      "finalizeNetworkRelay",
      relayMessage,
    );
  }

  /**
   * Handles relay-finalized callbacks and triggers downstream consumer creation.
   *
   * @param serverId - Ingress server id that emitted the finalized relay callback.
   * @param message - Relay finalized payload.
   * @returns `void`.
   */
  finalizedNetworkRelay(
    serverId: Guid,
    message: MediaInboundMessageMap["finalizedNetworkRelay"],
  ) {
    this.upsertPipeTransport(
      serverId,
      message.egressServer,
      message.routerNetwork,
      message.ingressPort,
      message.egressPort,
      message.producerId,
    );

    const outgoingMessages = this.context.consumerPlanner.createConsumerPayload(
      message.originId,
      message.producerId,
      message.kind,
      message.egressServer,
    );

    for (const consumerMessage of outgoingMessages) {
      this.context.signalingMessenger.sendNetsocketMessage(
        message.egressServer,
        "egress",
        "createConsumer",
        consumerMessage,
      );
    }
  }
}
