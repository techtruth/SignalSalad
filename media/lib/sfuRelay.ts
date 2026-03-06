import type {
  AppData,
  MediaKind,
  PipeTransport,
  Producer,
  RtpParameters,
  Router,
} from "mediasoup/types";

export const buildPipeTransportKey = (
  routerNetwork: string,
  remoteServerId: string,
) => `${routerNetwork}:${remoteServerId}`;

type GetOrCreateNetworkPipeTransport = (
  routerNetwork: string,
  remoteServerId: string,
  appData: AppData | undefined,
  context: string,
) => Promise<{ pipeRelay: PipeTransport; created: boolean }>;

type GetPipeTransportOrThrow = (
  routerNetwork: string,
  remoteServerId: string,
  context: string,
) => PipeTransport;

type GetPipeTransportRouterOrThrow = (
  routerNetwork: string,
  remoteServerId: string,
  context: string,
) => string;

type GetRoomRouterByIdOrThrow = (
  routerNetwork: string,
  routerId: string,
  context: string,
) => Router;

type EnsureProducerVisibleOnRouter = (
  producerId: string,
  targetRouter: Router,
  context: string,
) => Promise<void>;

export const createNetworkPipeTransportIngressRelay = async (params: {
  routerNetwork: string;
  remoteEgressId: string;
  appData?: AppData;
  getOrCreateNetworkPipeTransport: GetOrCreateNetworkPipeTransport;
}) => {
  const { pipeRelay, created } = await params.getOrCreateNetworkPipeTransport(
    params.routerNetwork,
    params.remoteEgressId,
    params.appData,
    "createNetworkPipeTransportIngress",
  );

  return {
    created,
    ingressIp: pipeRelay.tuple.localIp,
    ingressPort: pipeRelay.tuple.localPort,
    protocol: pipeRelay.tuple.protocol,
    appData: pipeRelay.appData,
  };
};

export const consumeNetworkPipeTransportRelay = async (params: {
  routerNetwork: string;
  producerId: string;
  remoteEgressId: string;
  appData?: AppData;
  getPipeTransportRouterOrThrow: GetPipeTransportRouterOrThrow;
  getRoomRouterByIdOrThrow: GetRoomRouterByIdOrThrow;
  ensureProducerVisibleOnRouter: EnsureProducerVisibleOnRouter;
  getPipeTransportOrThrow: GetPipeTransportOrThrow;
}) => {
  const pipeRouterId = params.getPipeTransportRouterOrThrow(
    params.routerNetwork,
    params.remoteEgressId,
    "consumeNetworkPipeTransport",
  );
  const pipeRouter = params.getRoomRouterByIdOrThrow(
    params.routerNetwork,
    pipeRouterId,
    "consumeNetworkPipeTransport",
  );
  await params.ensureProducerVisibleOnRouter(
    params.producerId,
    pipeRouter,
    "consumeNetworkPipeTransport",
  );
  const pipeRelay = params.getPipeTransportOrThrow(
    params.routerNetwork,
    params.remoteEgressId,
    "consumeNetworkPipeTransport",
  );
  const consumer = await pipeRelay.consume({
    producerId: params.producerId,
    appData: params.appData,
  });

  return {
    kind: consumer.kind,
    rtpParameters: consumer.rtpParameters,
    appData: consumer.appData,
  };
};

export const createNetworkPipeTransportEgressRelay = async (params: {
  shouldConnectPipeTransport: boolean;
  routerNetwork: string;
  remoteIngressId: string;
  ingressIp: string;
  ingressPort: number;
  appData: AppData;
  getOrCreateNetworkPipeTransport: GetOrCreateNetworkPipeTransport;
  networkPipeTransports: Map<string, PipeTransport>;
  networkPipeTransportRouterIds: Map<string, string>;
}) => {
  const { pipeRelay, created } = await params.getOrCreateNetworkPipeTransport(
    params.routerNetwork,
    params.remoteIngressId,
    params.appData,
    "createNetworkPipeTransportEgress",
  );
  if (params.shouldConnectPipeTransport !== created) {
    if (created) {
      const key = buildPipeTransportKey(
        params.routerNetwork,
        params.remoteIngressId,
      );
      if (!pipeRelay.closed) {
        pipeRelay.close();
      }
      params.networkPipeTransports.delete(key);
      params.networkPipeTransportRouterIds.delete(key);
    }
    throw new Error(
      `Relay connect handshake mismatch for ${params.routerNetwork}:${params.remoteIngressId}; shouldConnectPipeTransport=${params.shouldConnectPipeTransport}, created=${created}`,
    );
  }
  if (params.shouldConnectPipeTransport) {
    await pipeRelay.connect({ ip: params.ingressIp, port: params.ingressPort });
  }

  return {
    createdTransport: params.shouldConnectPipeTransport,
    egressIp: pipeRelay.tuple.localIp,
    egressPort: pipeRelay.tuple.localPort,
    protocol: pipeRelay.tuple.protocol,
    appData: pipeRelay.appData,
  };
};

export const produceNetworkPipeTransportRelay = async (params: {
  routerNetwork: string;
  producerId: string;
  remoteIngressId: string;
  consumerOptions: {
    kind: MediaKind;
    rtpParameters: RtpParameters;
    appData?: AppData;
  };
  getPipeTransportOrThrow: GetPipeTransportOrThrow;
  getPipeTransportRouterOrThrow: GetPipeTransportRouterOrThrow;
  pipeProducers: Map<string, Producer>;
  producerRoomNames: Map<string, string>;
  producerRouterIds: Map<string, string>;
  cleanupProducerRouting: (producerId: string) => void;
}) => {
  const pipeRelay = params.getPipeTransportOrThrow(
    params.routerNetwork,
    params.remoteIngressId,
    "produceNetworkPipeTransport",
  );
  const producer = await pipeRelay.produce({
    id: params.producerId,
    kind: params.consumerOptions.kind,
    rtpParameters: params.consumerOptions.rtpParameters,
    appData: params.consumerOptions.appData,
  });
  const existing = params.pipeProducers.get(params.producerId);
  if (existing) {
    existing.close();
  }
  producer.on("@close", () => {
    params.pipeProducers.delete(params.producerId);
    params.cleanupProducerRouting(params.producerId);
  });
  producer.on("transportclose", () => {
    params.pipeProducers.delete(params.producerId);
    params.cleanupProducerRouting(params.producerId);
  });
  params.pipeProducers.set(params.producerId, producer);
  const routerId = params.getPipeTransportRouterOrThrow(
    params.routerNetwork,
    params.remoteIngressId,
    "produceNetworkPipeTransport",
  );
  params.producerRoomNames.set(params.producerId, params.routerNetwork);
  params.producerRouterIds.set(params.producerId, routerId);
};

export const closePipeProducerRelay = async (params: {
  producerId: string;
  pipeProducers: Map<string, Producer>;
}) => {
  const producer = params.pipeProducers.get(params.producerId);
  if (!producer) {
    console.debug(`Pipe producer already closed ${params.producerId}`);
    return;
  }
  producer.close();
};

export const finalizeNetworkPipeTransportRelay = async (params: {
  connectedTransport: boolean;
  routerNetwork: string;
  remoteEgressId: string;
  egressIp: string;
  egressPort: number;
  getPipeTransportOrThrow: GetPipeTransportOrThrow;
}) => {
  const pipeRelay = params.getPipeTransportOrThrow(
    params.routerNetwork,
    params.remoteEgressId,
    "finalizeNetworkPipeTransport",
  );

  if (params.connectedTransport) {
    await pipeRelay.connect({ ip: params.egressIp, port: params.egressPort });
  }
  return {
    ingressIp: pipeRelay.tuple.localIp,
    ingressPort: pipeRelay.tuple.localPort,
    egressIp: params.egressIp,
    egressPort: params.egressPort,
  };
};
