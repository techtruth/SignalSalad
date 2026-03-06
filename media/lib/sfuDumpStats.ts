import type { PipeTransport, Router, WebRtcTransport } from "mediasoup/types";

/** Raw mediasoup router dump payload consumed by SFU diagnostics helpers. */
export type RouterDump = Awaited<ReturnType<Router["dump"]>>;
/** Raw mediasoup pipe-transport dump payload used in router-group diagnostics. */
export type PipeTransportDump = Awaited<ReturnType<PipeTransport["dump"]>>;
/** Warning record emitted when one transport stats sample fails during dump collection. */
export type RouterDumpWarning = {
  scope: "routerTransport" | "pipeTransport" | "webRTCTransport";
  message: string;
  transportId: string;
  error: unknown;
};

const STAT_KEYS = new Array<
  | "bytesSent"
  | "bytesReceived"
  | "sendBitrate"
  | "recvBitrate"
  | "rtpBytesSent"
  | "rtpBytesReceived"
  | "rtpSendBitrate"
  | "rtpRecvBitrate"
  | "rtxBytesSent"
  | "rtxBytesReceived"
  | "rtxSendBitrate"
  | "rtxRecvBitrate"
  | "availableOutgoingBitrate"
  | "availableIncomingBitrate"
>(
  "bytesSent",
  "bytesReceived",
  "sendBitrate",
  "recvBitrate",
  "rtpBytesSent",
  "rtpBytesReceived",
  "rtpSendBitrate",
  "rtpRecvBitrate",
  "rtxBytesSent",
  "rtxBytesReceived",
  "rtxSendBitrate",
  "rtxRecvBitrate",
  "availableOutgoingBitrate",
  "availableIncomingBitrate",
);

/** Aggregated numeric transport stat totals keyed by stat name. */
export type StatTotals = Record<string, number>;

const collectStatsTotals = async (
  transport: WebRtcTransport | PipeTransport,
) => {
  const totals: StatTotals = new Object() as StatTotals;
  const statsList = await transport.getStats();
  for (const stats of statsList) {
    const record = stats as unknown as Record<string, unknown>;
    STAT_KEYS.forEach((key) => {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        totals[key] = (totals[key] || 0) + value;
      }
    });
  }
  return totals;
};

/** @internal */
export async function collectRouterDumpStats({
  routers,
  pipeRelays,
  webrtcTransports,
  onWarning,
}: {
  routers: RouterDump[];
  pipeRelays: PipeTransport[];
  webrtcTransports: Map<string, WebRtcTransport>;
  onWarning?: (warning: RouterDumpWarning) => void;
}): Promise<{
  routers: Array<RouterDump & { transportStats?: StatTotals }>;
  webrtcTransportStats: Record<string, StatTotals>;
  pipeTransportStats: Record<string, StatTotals>;
}> {
  const pipeTransportsById = new Map<string, PipeTransport>();
  pipeRelays.forEach((pipe) => {
    if (!pipe.closed) {
      pipeTransportsById.set(pipe.id, pipe);
    }
  });

  const routersWithStats = await Promise.all(
    routers.map(async (routerDump) => {
      const totals: StatTotals = new Object() as StatTotals;
      const transportIds = Array.isArray(routerDump.transportIds)
        ? routerDump.transportIds
        : new Array<string>();
      for (const transportId of transportIds) {
        const transport =
          webrtcTransports.get(transportId) ||
          pipeTransportsById.get(transportId);
        if (!transport || transport.closed) {
          continue;
        }
        try {
          const stats = await collectStatsTotals(transport);
          Object.entries(stats).forEach(([key, value]) => {
            totals[key] = (totals[key] || 0) + value;
          });
        } catch (error) {
          onWarning?.({
            scope: "routerTransport",
            message: "Failed to read transport stats",
            transportId,
            error,
          });
          console.warn("Failed to read transport stats", transportId, error);
        }
      }
      return totals && Object.keys(totals).length
        ? { ...routerDump, transportStats: totals }
        : routerDump;
    }),
  );

  const pipeTransportStats = new Object() as Record<string, StatTotals>;
  for (const pipe of pipeRelays) {
    if (pipe.closed) {
      continue;
    }
    try {
      pipeTransportStats[pipe.id] = await collectStatsTotals(pipe);
    } catch (error) {
      onWarning?.({
        scope: "pipeTransport",
        message: "Failed to read pipe transport stats",
        transportId: pipe.id,
        error,
      });
      console.warn("Failed to read pipe transport stats", pipe.id, error);
    }
  }

  const webrtcTransportStats = new Object() as Record<string, StatTotals>;
  const routerTransportIds = new Set<string>();
  routersWithStats.forEach((routerDump) => {
    if (Array.isArray(routerDump.transportIds)) {
      routerDump.transportIds.forEach((transportId) => {
        routerTransportIds.add(transportId);
      });
    }
  });
  for (const transportId of routerTransportIds) {
    const transport = webrtcTransports.get(transportId);
    if (!transport || transport.closed) {
      continue;
    }
    try {
      webrtcTransportStats[transportId] = await collectStatsTotals(transport);
    } catch (error) {
      onWarning?.({
        scope: "webRTCTransport",
        message: "Failed to read WebRTC transport stats",
        transportId,
        error,
      });
      console.warn("Failed to read WebRTC transport stats", transportId, error);
    }
  }

  return {
    routers: routersWithStats,
    webrtcTransportStats,
    pipeTransportStats,
  };
}
