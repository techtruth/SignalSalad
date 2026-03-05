import type { PipeTransport, Router } from "mediasoup/types";

export type RouterDumpEntry = Awaited<ReturnType<Router["dump"]>>;
export type PipeTransportDumpEntry = Awaited<ReturnType<PipeTransport["dump"]>>;
export type TransportStats = Record<string, number>;
