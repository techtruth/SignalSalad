import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  SFU,
  chooseLeastLoadedWorkerIndex,
  resolveMediaWorkerCount,
} from "../../lib/sfuCore.js";

const createFakeWebRtcTransport = (id: string) => {
  const transport = new EventEmitter() as EventEmitter & {
    id: string;
    closed: boolean;
    iceParameters: object;
    iceCandidates: unknown[];
    dtlsParameters: object;
    sctpParameters: object;
    close: () => void;
  };
  transport.id = id;
  transport.closed = false;
  transport.iceParameters = {};
  transport.iceCandidates = [];
  transport.dtlsParameters = {};
  transport.sctpParameters = {};
  transport.close = () => {
    if (transport.closed) {
      return;
    }
    transport.closed = true;
    transport.emit("@close");
  };
  return transport;
};

const createFakeRouter = (routerId: string, workerIndex: number) => {
  let transportCounter = 0;
  return {
    id: routerId,
    closed: false,
    appData: { workerIndex },
    rtpCapabilities: {},
    async createWebRtcTransport() {
      transportCounter += 1;
      return createFakeWebRtcTransport(`${routerId}-transport-${transportCounter}`);
    },
    async dump() {
      return { id: routerId, transportIds: [], rtpObserverIds: [] };
    },
  };
};

test("sfu: resolveMediaWorkerCount defaults to omitting two CPUs", () => {
  assert.equal(resolveMediaWorkerCount(8, undefined), 6);
  assert.equal(resolveMediaWorkerCount(2, undefined), 1);
  assert.equal(resolveMediaWorkerCount(1, undefined), 1);
});

test("sfu: resolveMediaWorkerCount honors MEDIA_WORKER_OMIT_CPUS", () => {
  assert.equal(resolveMediaWorkerCount(8, "3"), 5);
  assert.equal(resolveMediaWorkerCount(8, "0"), 8);
  assert.equal(resolveMediaWorkerCount(8, "100"), 1);
});

test("sfu: resolveMediaWorkerCount rejects invalid omit values", () => {
  assert.throws(
    () => resolveMediaWorkerCount(8, "-1"),
    /Invalid MEDIA_WORKER_OMIT_CPUS value/,
  );
  assert.throws(
    () => resolveMediaWorkerCount(8, "abc"),
    /Invalid MEDIA_WORKER_OMIT_CPUS value/,
  );
  assert.throws(
    () => resolveMediaWorkerCount(8, "1.5"),
    /Invalid MEDIA_WORKER_OMIT_CPUS value/,
  );
});

test("sfu: chooseLeastLoadedWorkerIndex picks lowest CPU usage", () => {
  assert.equal(
    chooseLeastLoadedWorkerIndex([
      { workerIndex: 0, cpuUsageTotal: 120, assignedRooms: 2 },
      { workerIndex: 1, cpuUsageTotal: 80, assignedRooms: 9 },
      { workerIndex: 2, cpuUsageTotal: 95, assignedRooms: 1 },
    ]),
    1,
  );
});

test("sfu: chooseLeastLoadedWorkerIndex breaks ties by assigned rooms then index", () => {
  assert.equal(
    chooseLeastLoadedWorkerIndex([
      { workerIndex: 0, cpuUsageTotal: 100, assignedRooms: 3 },
      { workerIndex: 1, cpuUsageTotal: 100, assignedRooms: 2 },
      { workerIndex: 2, cpuUsageTotal: 100, assignedRooms: 2 },
    ]),
    1,
  );
});

test("sfu: reset awaits initialize completion", async () => {
  const sfu = new SFU("ingress");
  sfu.workers = [{ closed: true } as never];

  let releaseInitialize: (() => void) | undefined;
  sfu.initialize = async () => {
    await new Promise<void>((resolve) => {
      releaseInitialize = resolve;
    });
  };

  let settled = false;
  const pendingReset = sfu.reset().then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  releaseInitialize?.();
  await pendingReset;
  assert.equal(settled, true);
});

test("sfu: destroyRouterGroup is idempotent for missing room", async () => {
  const sfu = new SFU("ingress");
  await assert.doesNotReject(async () => {
    await sfu.destroyRouterGroup("missing-room");
  });
});

test(
  "sfu: createNetworkPipeTransportEgress rolls back created transport on handshake mismatch",
  async () => {
    const sfu = new SFU("egress");
    const pipeTransport = new EventEmitter() as EventEmitter & {
      closed: boolean;
      tuple: { localIp: string; localPort: number; protocol: "udp" };
      appData: Record<string, unknown>;
      connect: (params: { ip: string; port: number }) => Promise<void>;
      close: () => void;
    };
    pipeTransport.closed = false;
    pipeTransport.tuple = {
      localIp: "127.0.0.1",
      localPort: 45000,
      protocol: "udp",
    };
    pipeTransport.appData = {};
    let connectCalls = 0;
    pipeTransport.connect = async () => {
      connectCalls += 1;
    };
    pipeTransport.close = () => {
      if (pipeTransport.closed) {
        return;
      }
      pipeTransport.closed = true;
      pipeTransport.emit("routerclose");
    };

    const router = {
      ...createFakeRouter("router-pipe", 0),
      async createPipeTransport() {
        return pipeTransport;
      },
    };
    sfu.routerGroups.set("demo-pipe", [router as never]);

    await assert.rejects(
      sfu.createNetworkPipeTransportEgress(
        false,
        "demo-pipe",
        "ingress-1",
        "10.0.0.1",
        4000,
        {} as never,
      ),
      /Relay connect handshake mismatch/,
    );

    const key = "demo-pipe:ingress-1";
    assert.equal(pipeTransport.closed, true);
    assert.equal(connectCalls, 0);
    assert.equal(sfu.networkPipeTransports.has(key), false);
    assert.equal(sfu.networkPipeTransportRouterIds.has(key), false);
  },
);

test("sfu: room transport placement expands across least-loaded workers with deterministic tie-break", async () => {
  const sfu = new SFU("ingress");
  const createdRouters = new Array<{ workerIndex: number; routerId: string }>();
  const workerLoad = [30, 10, 20];

  sfu.workers = workerLoad.map((load, workerIndex) => {
    let routerCounter = 0;
    return {
      closed: false,
      async getResourceUsage() {
        return { ru_utime: load, ru_stime: 0 };
      },
      async createRouter() {
        routerCounter += 1;
        const routerId = `router-${workerIndex}-${routerCounter}`;
        createdRouters.push({ workerIndex, routerId });
        return createFakeRouter(routerId, workerIndex);
      },
    } as never;
  });
  sfu.webRtcServers = [{}, {}, {}] as never;

  await sfu.createRouterGroup("demo");
  const t1 = await sfu.createWebRTCIngressTransport("demo", {} as never);
  const t2 = await sfu.createWebRTCIngressTransport("demo", {} as never);
  const t3 = await sfu.createWebRTCIngressTransport("demo", {} as never);
  const t4 = await sfu.createWebRTCIngressTransport("demo", {} as never);
  const t5 = await sfu.createWebRTCIngressTransport("demo", {} as never);

  assert.equal(createdRouters.length, 3);
  assert.deepEqual(
    createdRouters.map((entry) => entry.workerIndex),
    [1, 2, 0],
  );
  assert.deepEqual(
    [
      sfu.transportRouterIds.get(t1.id),
      sfu.transportRouterIds.get(t2.id),
      sfu.transportRouterIds.get(t3.id),
      sfu.transportRouterIds.get(t4.id),
      sfu.transportRouterIds.get(t5.id),
    ],
    [
      "router-1-1",
      "router-2-1",
      "router-0-1",
      "router-2-1",
      "router-1-1",
    ],
  );
});

test("sfu: egress transport placement uses the same scaling expansion behavior", async () => {
  const sfu = new SFU("egress");
  const createdRouters = new Array<{ workerIndex: number; routerId: string }>();
  const workerLoad = [5, 25];

  sfu.workers = workerLoad.map((load, workerIndex) => {
    let routerCounter = 0;
    return {
      closed: false,
      async getResourceUsage() {
        return { ru_utime: load, ru_stime: 0 };
      },
      async createRouter() {
        routerCounter += 1;
        const routerId = `router-${workerIndex}-${routerCounter}`;
        createdRouters.push({ workerIndex, routerId });
        return createFakeRouter(routerId, workerIndex);
      },
    } as never;
  });
  sfu.webRtcServers = [{}, {}] as never;

  await sfu.createRouterGroup("demo-egress");
  const t1 = await sfu.createWebRTCEgressTransport("demo-egress", {} as never);
  const t2 = await sfu.createWebRTCEgressTransport("demo-egress", {} as never);

  assert.deepEqual(
    createdRouters.map((entry) => entry.workerIndex),
    [0, 1],
  );
  assert.equal(sfu.transportRouterIds.get(t1.id), "router-0-1");
  assert.equal(sfu.transportRouterIds.get(t2.id), "router-1-1");
});

test("sfu: transport tie-break chooses highest worker index for equal router load", async () => {
  const sfu = new SFU("ingress");
  sfu.workers = [{ closed: false }, { closed: false }, { closed: false }] as never;
  sfu.webRtcServers = [{}, {}, {}] as never;

  sfu.routerGroups.set("demo-tie", [
    createFakeRouter("router-0", 0) as never,
    createFakeRouter("router-1", 1) as never,
    createFakeRouter("router-2", 2) as never,
  ]);

  sfu.transports.set("existing-t0", createFakeWebRtcTransport("existing-t0") as never);
  sfu.transportRoomNames.set("existing-t0", "demo-tie");
  sfu.transportRouterIds.set("existing-t0", "router-0");

  sfu.transports.set("existing-t1", createFakeWebRtcTransport("existing-t1") as never);
  sfu.transportRoomNames.set("existing-t1", "demo-tie");
  sfu.transportRouterIds.set("existing-t1", "router-1");

  sfu.transports.set("existing-t2", createFakeWebRtcTransport("existing-t2") as never);
  sfu.transportRoomNames.set("existing-t2", "demo-tie");
  sfu.transportRouterIds.set("existing-t2", "router-2");

  const created = await sfu.createWebRTCIngressTransport("demo-tie", {} as never);
  assert.equal(sfu.transportRouterIds.get(created.id), "router-2");
});

test("sfu: room scaling does not expand when an existing room router is unused", async () => {
  const sfu = new SFU("ingress");
  let createRouterCalls = 0;
  sfu.workers = [0, 1, 2].map((workerIndex) => {
    return {
      closed: false,
      async getResourceUsage() {
        return { ru_utime: workerIndex, ru_stime: 0 };
      },
      async createRouter() {
        createRouterCalls += 1;
        return createFakeRouter(`router-created-${workerIndex}`, workerIndex);
      },
    } as never;
  });
  sfu.webRtcServers = [{}, {}, {}] as never;

  sfu.routerGroups.set("demo-unused", [
    createFakeRouter("router-a", 0) as never,
    createFakeRouter("router-b", 1) as never,
  ]);

  sfu.transports.set("existing-a", createFakeWebRtcTransport("existing-a") as never);
  sfu.transportRoomNames.set("existing-a", "demo-unused");
  sfu.transportRouterIds.set("existing-a", "router-a");

  const created = await sfu.createWebRTCIngressTransport("demo-unused", {} as never);

  assert.equal(createRouterCalls, 0);
  assert.equal(sfu.transportRouterIds.get(created.id), "router-b");
});

test("sfu: createRouterGroup fails when a worker usage probe fails", async () => {
  const sfu = new SFU("ingress");
  const createdRouters = new Array<{ workerIndex: number; routerId: string }>();
  sfu.workers = [0, 1].map((workerIndex) => {
    let routerCounter = 0;
    return {
      closed: false,
      async getResourceUsage() {
        if (workerIndex === 0) {
          throw new Error("usage unavailable");
        }
        return { ru_utime: 5, ru_stime: 0 };
      },
      async createRouter() {
        routerCounter += 1;
        const routerId = `router-${workerIndex}-${routerCounter}`;
        createdRouters.push({ workerIndex, routerId });
        return createFakeRouter(routerId, workerIndex);
      },
    } as never;
  });

  await assert.rejects(
    sfu.createRouterGroup("demo-usage-fallback"),
    /usage unavailable/,
  );
  assert.deepEqual(createdRouters, []);
});

test("sfu: createEgressConsumer pipes producers into the consumer transport router", async () => {
  const sfu = new SFU("egress");
  const pipeCalls = new Array<{ producerId: string; targetRouterId: string }>();

  const sourceRouter = {
    ...createFakeRouter("router-source", 0),
    async pipeToRouter(options: { producerId: string; router: { id: string } }) {
      pipeCalls.push({
        producerId: options.producerId,
        targetRouterId: options.router.id,
      });
      return { pipeProducer: { id: options.producerId } };
    },
  };
  const targetRouter = createFakeRouter("router-target", 1);
  sfu.routerGroups.set("demo", [sourceRouter as never, targetRouter as never]);

  const consumerTransport = {
    id: "transport-target",
    closed: false,
    async consume() {
      const consumer = new EventEmitter() as EventEmitter & {
        id: string;
        producerId: string;
        kind: "video";
        rtpParameters: object;
        appData: object;
      };
      consumer.id = "consumer-1";
      consumer.producerId = "producer-1";
      consumer.kind = "video";
      consumer.rtpParameters = {};
      consumer.appData = {};
      return consumer;
    },
  } as never;
  sfu.transports.set("transport-target", consumerTransport);
  sfu.transportRoomNames.set("transport-target", "demo");
  sfu.transportRouterIds.set("transport-target", "router-target");
  sfu.producerRoomNames.set("producer-1", "demo");
  sfu.producerRouterIds.set("producer-1", "router-source");

  await sfu.createEgressConsumer(
    [{ peerA: ["producer-1"] }],
    ["transport-target"],
    {} as never,
  );
  await sfu.createEgressConsumer(
    [{ peerA: ["producer-1"] }],
    ["transport-target"],
    {} as never,
  );

  assert.deepEqual(pipeCalls, [
    { producerId: "producer-1", targetRouterId: "router-target" },
  ]);
});
