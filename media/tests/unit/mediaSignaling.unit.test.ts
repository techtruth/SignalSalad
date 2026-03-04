import assert from "node:assert/strict";
import test from "node:test";

import { MediaSignaling } from "../../lib/mediaSignaling.js";

type OutboundEnvelope = {
  node: string;
  payload: {
    type: string;
    message: Record<string, unknown>;
  };
};

const makeSfuStub = (mode: "ingress" | "egress") => {
  const calls = {
    closeProducer: [] as string[],
    closePipeProducer: [] as string[],
    destroyRouterGroup: [] as string[],
    disconnectWebRTCTransport: [] as string[],
    setProducerPaused: [] as Array<{ producerId: string; paused: boolean }>,
    connectWebRTCIngressTransport: [] as string[],
    connectWebRTCEgressTransport: [] as string[],
    createWebRTCIngressTransport: [] as string[],
  };

  const sfu = {
    mode,
    producers: new Map<string, { kind: "audio" | "video" }>(),
    onProducerClosed: undefined as
      | ((producerId: string, kind: "audio" | "video") => void)
      | undefined,
    onTransportClosed: undefined as
      | ((transportId: string, direction: "ingress" | "egress") => void)
      | undefined,
    async reset() {},
    async destroyRouterGroup(routerNetwork: string) {
      calls.destroyRouterGroup.push(routerNetwork);
    },
    async closeProducer(producerId: string) {
      calls.closeProducer.push(producerId);
      const producer = sfu.producers.get(producerId);
      if (!producer) {
        return;
      }
      sfu.producers.delete(producerId);
      sfu.onProducerClosed?.(producerId, producer.kind);
    },
    async closePipeProducer(producerId: string) {
      calls.closePipeProducer.push(producerId);
    },
    disconnectWebRTCTransport(transportId: string) {
      calls.disconnectWebRTCTransport.push(transportId);
    },
    setProducerPaused(producerId: string, paused: boolean) {
      calls.setProducerPaused.push({ producerId, paused });
    },
    async connectWebRTCIngressTransport(transportId: string) {
      calls.connectWebRTCIngressTransport.push(transportId);
    },
    async connectWebRTCEgressTransport(transportId: string) {
      calls.connectWebRTCEgressTransport.push(transportId);
    },
    async createWebRTCIngressTransport(routerNetwork: string) {
      calls.createWebRTCIngressTransport.push(routerNetwork);
      return {
        id: "ingress-transport-1",
        iceParameters: {},
        iceCandidates: [],
        dtlsParameters: {},
        sctpParameters: {},
      };
    },
  };

  return { sfu, calls };
};

const makeHarness = (mode: "ingress" | "egress") => {
  const { sfu, calls } = makeSfuStub(mode);
  const signaling = new MediaSignaling(sfu as never);
  const outbound = new Array<OutboundEnvelope>();

  signaling.encoder = {
    write(buffer: Buffer) {
      outbound.push(JSON.parse(buffer.toString()) as OutboundEnvelope);
      return true;
    },
  } as never;

  return { signaling, outbound, calls, sfu };
};

test("mediaSignaling: handleProducerClosed ignores unknown mapping", () => {
  const h = makeHarness("ingress");
  h.signaling.handleProducerClosed("producer-missing", "video");
  assert.equal(h.outbound.length, 0);
});

test("mediaSignaling: handleProducerClosed emits producerClosed for known mapping", () => {
  const h = makeHarness("ingress");
  h.signaling.producerOrigins.set("producer-a", {
    originId: "origin-a",
    mediaType: "audio",
  });

  h.signaling.handleProducerClosed("producer-a", "audio");

  assert.equal(h.outbound.length, 1);
  assert.equal(h.outbound[0].payload.type, "producerClosed");
  assert.equal(h.outbound[0].payload.message.originId, "origin-a");
  assert.equal(h.outbound[0].payload.message.producerId, "producer-a");
  assert.equal(h.outbound[0].payload.message.mediaType, "audio");
  assert.equal(h.signaling.producerOrigins.has("producer-a"), false);
});

test("mediaSignaling: handleTransportClosed emits disconnected payload and clears mapping", () => {
  const h = makeHarness("ingress");
  h.signaling.transportOrigins.set("transport-a", {
    originId: "origin-a",
    direction: "ingress",
  });

  h.signaling.handleTransportClosed("transport-a", "ingress");

  assert.equal(h.outbound.length, 1);
  assert.equal(h.outbound[0].payload.type, "disconnectedWebRTCTransport");
  assert.equal(h.outbound[0].payload.message.transportId, "transport-a");
  assert.equal(h.outbound[0].payload.message.originId, "origin-a");
  assert.equal(h.outbound[0].payload.message.direction, "ingress");
  assert.equal(h.signaling.transportOrigins.has("transport-a"), false);
});

test("mediaSignaling: closeProducer uses ingress close path and emits producerClosed", async () => {
  const h = makeHarness("ingress");
  h.signaling.producerOrigins.set("producer-a", {
    originId: "origin-a",
    mediaType: "audio",
  });
  h.sfu.producers.set("producer-a", { kind: "audio" });

  await h.signaling.closeProducer({
    originId: "origin-a",
    producerId: "producer-a",
    mediaType: "audio",
  });

  assert.deepEqual(h.calls.closeProducer, ["producer-a"]);
  assert.deepEqual(h.calls.closePipeProducer, []);
  assert.equal(h.outbound.at(-1)?.payload.type, "producerClosed");
});

test("mediaSignaling: closeProducer ingress with missing producer does not emit producerClosed", async () => {
  const h = makeHarness("ingress");
  await h.signaling.closeProducer({
    originId: "origin-a",
    producerId: "missing-producer",
    mediaType: "audio",
  });
  assert.deepEqual(h.calls.closeProducer, ["missing-producer"]);
  assert.equal(h.outbound.length, 0);
});

test("mediaSignaling: closeProducer without producerId fails fast", async () => {
  const h = makeHarness("ingress");
  await assert.rejects(
    h.signaling.closeProducer({
      originId: "origin-a",
      producerId: "" as never,
      mediaType: "audio",
    }),
    /Missing producerId on producerClose/,
  );
  assert.deepEqual(h.calls.closeProducer, []);
  assert.deepEqual(h.calls.closePipeProducer, []);
  assert.equal(h.outbound.length, 0);
});

test("mediaSignaling: closeProducer uses egress close path only", async () => {
  const h = makeHarness("egress");
  h.signaling.producerOrigins.set("producer-a", {
    originId: "origin-a",
    mediaType: "video",
  });

  await h.signaling.closeProducer({
    originId: "origin-a",
    producerId: "producer-a",
    mediaType: "video",
  });

  assert.deepEqual(h.calls.closeProducer, []);
  assert.deepEqual(h.calls.closePipeProducer, ["producer-a"]);
  assert.equal(
    h.outbound.some((m) => m.payload.type === "producerClosed"),
    false,
  );
});

test("mediaSignaling: incoming createWebRTCIngressTransport dispatches and emits created response", async () => {
  const h = makeHarness("ingress");

  await h.signaling.incomingNetsocketSignal({
    node: "signaling",
    payload: {
      type: "createWebRTCIngressTransport",
      message: {
        originId: "origin-a",
        routerNetwork: "demo",
        sctpOptions: {},
      },
    },
  } as never);

  assert.deepEqual(h.calls.createWebRTCIngressTransport, ["demo"]);
  assert.equal(h.outbound.length, 1);
  assert.equal(h.outbound[0].payload.type, "createdWebRTCIngressTransport");
  assert.equal(
    h.outbound[0].payload.message.transportId,
    "ingress-transport-1",
  );
  assert.equal(
    h.signaling.transportOrigins.get("ingress-transport-1")?.originId,
    "origin-a",
  );
});

test("mediaSignaling: incoming connectWebRTCIngressTransport dispatches and emits connected response", async () => {
  const h = makeHarness("ingress");

  await h.signaling.incomingNetsocketSignal({
    node: "signaling",
    payload: {
      type: "connectWebRTCIngressTransport",
      message: {
        originId: "origin-a",
        transportId: "ingress-transport-1",
        dtlsParameters: {},
      },
    },
  } as never);

  assert.deepEqual(h.calls.connectWebRTCIngressTransport, [
    "ingress-transport-1",
  ]);
  assert.equal(h.outbound.at(-1)?.payload.type, "connectedWebRTCIngressTransport");
});

test("mediaSignaling: incoming teardownPeerSession closes peer resources", async () => {
  const h = makeHarness("ingress");
  h.signaling.transportOrigins.set("transport-origin-only", {
    originId: "origin-a",
    direction: "ingress",
  });
  h.signaling.producerOrigins.set("producer-origin-only", {
    originId: "origin-a",
    mediaType: "audio",
  });

  await h.signaling.incomingNetsocketSignal({
    node: "signaling",
    payload: {
      type: "teardownPeerSession",
      message: {
        originId: "origin-a",
        peerId: "peer-a",
        operationId: "op-1",
        mode: "leaving",
        transportIds: ["transport-listed"],
        producerIds: ["producer-listed"],
      },
    },
  } as never);

  assert.deepEqual(h.calls.disconnectWebRTCTransport, [
    "transport-listed",
    "transport-origin-only",
  ]);
  assert.deepEqual(h.calls.closeProducer, [
    "producer-listed",
    "producer-origin-only",
  ]);
  assert.equal(h.outbound.length, 0);
});

test("mediaSignaling: incoming destroyRouterGroup awaits sfu completion", async () => {
  const h = makeHarness("ingress");
  let releaseDestroy: (() => void) | undefined;
  h.sfu.destroyRouterGroup = async (routerNetwork: string) => {
    h.calls.destroyRouterGroup.push(routerNetwork);
    await new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
  };

  let settled = false;
  const pending = h.signaling
    .incomingNetsocketSignal({
      node: "signaling",
      payload: {
        type: "destroyRouterGroup",
        message: {
          routerNetwork: "demo",
        },
      },
    } as never)
    .then(() => {
      settled = true;
    });

  await Promise.resolve();
  assert.equal(settled, false);
  releaseDestroy?.();
  await pending;
  assert.deepEqual(h.calls.destroyRouterGroup, ["demo"]);
});

test("mediaSignaling: clearState awaits reset then clears origin tracking and load timer", async () => {
  const h = makeHarness("ingress");
  h.signaling.producerOrigins.set("producer-a", {
    originId: "origin-a",
    mediaType: "audio",
  });
  h.signaling.transportOrigins.set("transport-a", {
    originId: "origin-a",
    direction: "ingress",
  });
  h.signaling.loadInterval = setInterval(() => {}, 1000);

  let releaseReset: (() => void) | undefined;
  h.sfu.reset = async () => {
    await new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
  };

  const clearPromise = h.signaling.clearState();
  await Promise.resolve();
  assert.equal(h.signaling.producerOrigins.size, 1);
  assert.equal(h.signaling.transportOrigins.size, 1);
  releaseReset?.();
  await clearPromise;

  assert.equal(h.signaling.producerOrigins.size, 0);
  assert.equal(h.signaling.transportOrigins.size, 0);
  assert.equal(h.signaling.loadInterval, undefined);
});

test("mediaSignaling: incoming setProducerPaused dispatches to sfu", async () => {
  const h = makeHarness("ingress");

  await h.signaling.incomingNetsocketSignal({
    node: "signaling",
    payload: {
      type: "setProducerPaused",
      message: {
        producerId: "producer-x",
        paused: true,
      },
    },
  } as never);

  assert.deepEqual(h.calls.setProducerPaused, [
    { producerId: "producer-x", paused: true },
  ]);
});

test("mediaSignaling: incoming buffer parse failure destroys socket without crashing test", async () => {
  const h = makeHarness("ingress");
  let destroyedWith: unknown;
  h.signaling.clientSocket = {
    destroy(error?: unknown) {
      destroyedWith = error;
      return this as never;
    },
  } as never;
  (h.signaling as never as { scheduleFatalExit: () => void }).scheduleFatalExit =
    () => {};

  await (
    h.signaling as never as { handleIncomingBuffer: (buffer: Buffer) => Promise<void> }
  ).handleIncomingBuffer(Buffer.from("{not-json"));

  assert.ok(destroyedWith instanceof Error);
  assert.equal(h.outbound.length, 0);
});

test("mediaSignaling: incoming buffer dispatch failure destroys socket without parse label", async () => {
  const h = makeHarness("ingress");
  let destroyedWith: unknown;
  h.signaling.clientSocket = {
    destroy(error?: unknown) {
      destroyedWith = error;
      return this as never;
    },
  } as never;
  (h.signaling as never as { scheduleFatalExit: () => void }).scheduleFatalExit =
    () => {};
  (
    h.signaling as never as {
      incomingNetsocketSignal: (_signal: unknown) => Promise<void>;
    }
  ).incomingNetsocketSignal = async () => {
    throw new Error("dispatch failed");
  };

  await (
    h.signaling as never as { handleIncomingBuffer: (buffer: Buffer) => Promise<void> }
  ).handleIncomingBuffer(
    Buffer.from(
      JSON.stringify({
        node: "signaling",
        payload: { type: "createRouterGroup", message: { room: "demo" } },
      }),
    ),
  );

  assert.ok(destroyedWith instanceof Error);
  assert.match((destroyedWith as Error).message, /dispatch failed/);
});

test("mediaSignaling: shutdown sends unregister and ends socket", async () => {
  const h = makeHarness("ingress");
  let endCalled = false;
  let destroyCalled = false;
  h.signaling.clientSocket = {
    end(callback?: () => void) {
      endCalled = true;
      callback?.();
      return this as never;
    },
    destroy() {
      destroyCalled = true;
      return this as never;
    },
  } as never;
  h.signaling.loadInterval = setInterval(() => {}, 1000);

  await h.signaling.shutdown("maintenance", "planned");

  assert.equal(endCalled, true);
  assert.equal(destroyCalled, false);
  assert.equal(h.signaling.loadInterval, undefined);
  assert.equal(h.outbound.at(-1)?.payload.type, "unregisterMediaServer");
  assert.equal(h.outbound.at(-1)?.payload.message.mode, "ingress");
  assert.equal(h.outbound.at(-1)?.payload.message.region, "local");
  assert.equal(h.outbound.at(-1)?.payload.message.reason, "maintenance");
  assert.equal(h.outbound.at(-1)?.payload.message.detail, "planned");
});

test("mediaSignaling: inbound queue overflow emits mediaDiagnostic and fails fast", async () => {
  const h = makeHarness("ingress");
  h.signaling.instructionQueueLimit = 1;
  let releaseFirst: (() => void) | undefined;
  (
    h.signaling as never as {
      incomingNetsocketSignal: (_signal: unknown) => Promise<void>;
    }
  ).incomingNetsocketSignal = async () =>
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  (
    h.signaling as never as {
      handleFatalError: (_context: string, _error: unknown) => void;
    }
  ).handleFatalError = () => {};

  const messageBuffer = Buffer.from(
    JSON.stringify({
      node: "signaling",
      payload: { type: "createRouterGroup", message: { room: "demo" } },
    }),
  );
  const firstRequest = (
    h.signaling as never as { handleIncomingBuffer: (buffer: Buffer) => Promise<void> }
  ).handleIncomingBuffer(messageBuffer);
  await Promise.resolve();

  await (
    h.signaling as never as { handleIncomingBuffer: (buffer: Buffer) => Promise<void> }
  ).handleIncomingBuffer(messageBuffer);

  assert.ok(
    h.outbound.some((entry) => entry.payload.type === "mediaDiagnostic"),
  );

  releaseFirst?.();
  await firstRequest;
});

test("mediaSignaling: incomingNetsocketSignal rejects unknown request type", async () => {
  const h = makeHarness("ingress");

  await assert.rejects(
    h.signaling.incomingNetsocketSignal({
      node: "signaling",
      payload: {
        type: "totallyUnknownRequest",
        message: {},
      },
    } as never),
    /Unknown incoming netsocket request type/,
  );
});
