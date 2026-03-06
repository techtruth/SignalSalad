/**
 * Why this file exists:
 * - Signaling policy hooks are intended customization seams and must stay stable.
 * - Regressions in policy wiring can silently bypass guardrails.
 *
 * What this suite protects:
 * - admission policy controls identity acceptance/rejection.
 * - rate-limit policy controls per-request admission and reset-on-disconnect behavior.
 * - room media policy controls request-side consume and send-side upload gates.
 * - WebRTC transport policy controls ingress/egress create/connect gates.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Guid } from "../../../types/baseTypes.d.ts";
import Signaling from "../../lib/signaling/signaling.js";
import {
  createFixedWindowRateLimitPolicy,
} from "../../lib/signaling/policies/rateLimitPolicy.js";
import type { PartialSignalingPolicies } from "../../lib/signaling/policies/types.js";
import { createTestServers } from "./testServers.js";

type FakeWs = {
  sent: string[];
  closeCodes: number[];
  send: (payload: string) => void;
  close: (code: number) => void;
};

const createFakeWs = (): FakeWs => ({
  sent: [],
  closeCodes: [],
  send(payload: string) {
    this.sent.push(payload);
  },
  close(code: number) {
    this.closeCodes.push(code);
  },
});

const parseWsMessages = (socket: FakeWs) =>
  socket.sent.map(
    (entry) =>
      JSON.parse(entry) as {
        type: string;
        message: Record<string, unknown>;
      },
  );

const getErrorMessages = (socket: FakeWs) =>
  parseWsMessages(socket).filter((msg) => msg.type === "error");

const withSilencedLogs = async <T>(fn: () => Promise<T>): Promise<T> => {
  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
};

const createHarness = (policies?: PartialSignalingPolicies) => {
  const wsid = "ws-policy-1" as Guid;
  const region = "local";
  const room = "demo";
  const ingressServerId = "ingress-1" as Guid;
  const egressServerId = "egress-1" as Guid;

  const ws = createFakeWs();
  const wsClients = new Map<Guid, unknown>([[wsid, ws as unknown]]);

  const servers = createTestServers({
    wsClients,
  });

  const manager = new Signaling({
    ...servers,
    ingressRegions: { [region]: [ingressServerId] },
    egressRegions: { [region]: [egressServerId] },
    ingressLoad: { [region]: { [ingressServerId]: 1 } },
    egressLoad: { [region]: { [egressServerId]: 1 } },
    policies,
  });

  return {
    manager,
    wsid,
    ws,
    region,
    room,
    ingressServerId,
    egressServerId,
  };
};

const requestIdentityAndGetPeerId = async (
  manager: Signaling,
  wsid: Guid,
  socket: FakeWs,
  region: string,
) => {
  await manager.incomingWebsocketSignal(wsid, {
    type: "requestIdentity",
    message: { region },
  });
  const identity = parseWsMessages(socket).find((msg) => msg.type === "identity");
  assert.ok(identity, "expected identity response");
  return identity.message.peerId as Guid;
};

test("policies: admission can reject identity with explicit error/detail", async () => {
  const harness = createHarness({
    admission: {
      validateIdentityRegion: ({ region, hasRegion }) => {
        assert.equal(hasRegion(region), true);
        return {
          allowed: false,
          error: "admissionDenied",
          detail: `blocked region ${region}`,
        };
      },
    },
  });

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "requestIdentity",
    message: { region: harness.region },
  });

  const outbound = parseWsMessages(harness.ws);
  const identity = outbound.find((msg) => msg.type === "identity");
  assert.equal(identity, undefined);

  const error = outbound.find((msg) => msg.type === "error");
  assert.ok(error);
  assert.deepEqual(error.message, {
    error: "admissionDenied",
    detail: `blocked region ${harness.region}`,
  });
});

test("policies: rate limit rejects excess requests and resets on websocket close", async () => {
  const harness = createHarness({
    rateLimit: createFixedWindowRateLimitPolicy({
      maxRequestsPerWindow: 1,
      windowMs: 60_000,
    }),
  });

  await withSilencedLogs(async () => {
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "requestSystemStatus",
      message: {},
    });
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "requestSystemStatus",
      message: {},
    });
  });

  const afterSecondRequest = getErrorMessages(harness.ws);
  assert.equal(afterSecondRequest.length, 1);
  assert.equal(afterSecondRequest[0]?.message.error, "requestRejected");
  assert.match(
    String(afterSecondRequest[0]?.message.detail),
    /request rate limit exceeded/,
  );

  harness.manager.onWebsocketClose(harness.wsid);

  await harness.manager.incomingWebsocketSignal(harness.wsid, {
    type: "requestSystemStatus",
    message: {},
  });

  const afterDisconnectReset = getErrorMessages(harness.ws);
  assert.equal(afterDisconnectReset.length, 1);
});

test("policies: room media request policy gates room audio/video fetch requests", async () => {
  const requestedAudioBy: Guid[] = [];
  const requestedVideoBy: Guid[] = [];
  const harness = createHarness({
    roomMedia: {
      allowRoomAudioRequest: ({ actorPeerId }) => {
        requestedAudioBy.push(actorPeerId);
        return false;
      },
      allowRoomVideoRequest: ({ actorPeerId }) => {
        requestedVideoBy.push(actorPeerId);
        return false;
      },
    },
  });

  const peerId = await requestIdentityAndGetPeerId(
    harness.manager,
    harness.wsid,
    harness.ws,
    harness.region,
  );

  await withSilencedLogs(async () => {
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "requestRoomAudio",
      message: { requestingPeer: peerId },
    });
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "requestRoomVideo",
      message: { requestingPeer: peerId },
    });
  });

  assert.deepEqual(requestedAudioBy, [peerId]);
  assert.deepEqual(requestedVideoBy, [peerId]);

  const errors = getErrorMessages(harness.ws);
  assert.equal(errors.length, 2);
  for (const event of errors) {
    assert.equal(event.message.error, "requestRejected");
    assert.match(
      String(event.message.detail),
      /room media policy rejected request/,
    );
  }
});

test("policies: room media upload policy gates produceMedia audio/video publish requests", async () => {
  const uploadedAudioBy: Guid[] = [];
  const uploadedVideoBy: Guid[] = [];
  const harness = createHarness({
    roomMedia: {
      allowRoomAudioUpload: ({ actorPeerId }) => {
        uploadedAudioBy.push(actorPeerId);
        return false;
      },
      allowRoomVideoUpload: ({ actorPeerId }) => {
        uploadedVideoBy.push(actorPeerId);
        return false;
      },
    },
  });

  const peerId = await requestIdentityAndGetPeerId(
    harness.manager,
    harness.wsid,
    harness.ws,
    harness.region,
  );

  await withSilencedLogs(async () => {
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "produceMedia",
      message: {
        producingPeer: peerId,
        transportId: "transport-audio" as Guid,
        producerOptions: { kind: "audio", rtpParameters: {}, appData: {} },
        requestId: "req-audio",
      },
    });
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "produceMedia",
      message: {
        producingPeer: peerId,
        transportId: "transport-video" as Guid,
        producerOptions: { kind: "video", rtpParameters: {}, appData: {} },
        requestId: "req-video",
      },
    });
  });

  assert.deepEqual(uploadedAudioBy, [peerId]);
  assert.deepEqual(uploadedVideoBy, [peerId]);

  const errors = getErrorMessages(harness.ws);
  assert.equal(errors.length, 2);
  for (const event of errors) {
    assert.equal(event.message.error, "requestRejected");
    assert.match(
      String(event.message.detail),
      /room media policy rejected upload request/,
    );
  }
});

test("policies: WebRTC transport policy gates ingress/egress create and connect actions", async () => {
  const seenActions: string[] = [];
  const harness = createHarness({
    webRTCTransport: {
      allowIngressTransportAction: ({ actorPeerId, action }) => {
        seenActions.push(`ingress:${action}:${actorPeerId}`);
        return false;
      },
      allowEgressTransportAction: ({ actorPeerId, action }) => {
        seenActions.push(`egress:${action}:${actorPeerId}`);
        return false;
      },
    },
  });

  const peerId = await requestIdentityAndGetPeerId(
    harness.manager,
    harness.wsid,
    harness.ws,
    harness.region,
  );

  const sctp = { OS: 1, MIS: 1 };
  const rtpCapabilities = { codecs: [], headerExtensions: [] };

  await withSilencedLogs(async () => {
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "createIngress",
      message: {
        peerId,
        room: harness.room,
        numStreams: sctp,
        rtpCapabilities,
      },
    });
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "createEgress",
      message: {
        peerId,
        room: harness.room,
        numStreams: sctp,
        rtpCapabilities,
        serverId: harness.egressServerId,
      },
    });
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "connectIngress",
      message: {
        peerId,
        transportId: "transport-ingress" as Guid,
        dtlsParameters: {},
      },
    });
    await harness.manager.incomingWebsocketSignal(harness.wsid, {
      type: "connectEgress",
      message: {
        peerId,
        transportId: "transport-egress" as Guid,
        dtlsParameters: {},
        serverId: harness.egressServerId,
      },
    });
  });

  assert.deepEqual(seenActions, [
    `ingress:create:${peerId}`,
    `egress:create:${peerId}`,
    `ingress:connect:${peerId}`,
    `egress:connect:${peerId}`,
  ]);

  const errors = getErrorMessages(harness.ws);
  assert.equal(errors.length, 4);
  for (const event of errors) {
    assert.equal(event.message.error, "requestRejected");
    assert.match(
      String(event.message.detail),
      /WebRTC transport policy rejected/,
    );
  }
});
