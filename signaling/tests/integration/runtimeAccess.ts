import Signaling from "../../lib/signaling/signaling.js";

export type SignalingDiagnostic = {
  category: string;
  message: string;
  details?: string;
};

type SignalingTestAccess<TRuntime> = {
  runtime: TRuntime;
  getRecentDiagnostics: () => SignalingDiagnostic[];
};

export const getSignalingRuntime = <TRuntime>(manager: Signaling): TRuntime =>
  (manager as unknown as SignalingTestAccess<TRuntime>).runtime;

export const getSignalingDiagnostics = (
  manager: Signaling,
): SignalingDiagnostic[] =>
  (manager as unknown as SignalingTestAccess<unknown>).getRecentDiagnostics();
