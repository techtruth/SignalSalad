/**
 * Why this file exists:
 * - MediaServerRegistry is now lifecycle-aware, not just a passive set of maps.
 * - Server registration, load updates, and ejection must keep routing indexes
 *   and lifecycle state aligned.
 *
 * What this suite protects:
 * - register -> active -> ejected lifecycle transitions.
 * - connected-state answers for signaling server selection.
 * - region/index pruning behavior after ejection.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { MediaServerRegistry } from "../../lib/core/mediaServer/serverRegistry.js";

const TEST_MAX_DISCONNECTED_SERVERS = 256;

const createRegistry = (params?: { maxDisconnectedServers?: number }) =>
  new MediaServerRegistry({
    ingressRegions: {},
    egressRegions: {},
    ingressLoad: {},
    egressLoad: {},
    ingressLoadDetail: {},
    egressLoadDetail: {},
    maxDisconnectedServers:
      params?.maxDisconnectedServers ?? TEST_MAX_DISCONNECTED_SERVERS,
  });

test("server registry lifecycle: register creates connected registered lifecycle record", () => {
  const index = createRegistry();

  index.registerServer("ingress", "local", "ingress-1");

  const lifecycle = index.getServerLifecycle("ingress-1");
  assert.ok(lifecycle);
  assert.equal(lifecycle.phase, "registered");
  assert.equal(lifecycle.connected, true);
  assert.equal(lifecycle.mode, "ingress");
  assert.equal(lifecycle.region, "local");
  assert.equal(index.isServerConnected("ingress-1"), true);
});

test("server registry lifecycle: load report promotes server lifecycle to active", () => {
  const index = createRegistry();

  index.registerServer("egress", "local", "egress-1");
  index.setServerLoadSnapshot("egress", "local", "egress-1", 12, [10, 14]);

  const lifecycle = index.getServerLifecycle("egress-1");
  assert.ok(lifecycle);
  assert.equal(lifecycle.phase, "active");
  assert.equal(lifecycle.connected, true);
  assert.equal(lifecycle.loadAvg, 12);
  assert.deepEqual(lifecycle.loadPerCpu, [10, 14]);
  assert.equal(index.getLeastLoadedServerByMode("egress", "local"), "egress-1");
});

test("server registry lifecycle: load report requires prior registration", () => {
  const index = createRegistry();

  assert.throws(
    () => index.setServerLoadSnapshot("ingress", "local", "ingress-1", 5, [5]),
    /server is not registered/,
  );
});

test("server registry lifecycle: load report must match registered region", () => {
  const index = createRegistry();

  index.registerServer("ingress", "local", "ingress-1");

  assert.throws(
    () =>
      index.setServerLoadSnapshot("ingress", "eu-west", "ingress-1", 10, [10]),
    /does not match registered region/,
  );
});

test("server registry lifecycle: prune marks server ejected and removes routing indexes", () => {
  const index = createRegistry();

  index.registerServer("ingress", "local", "ingress-1");
  index.setServerLoadSnapshot("ingress", "local", "ingress-1", 20, [20]);
  index.pruneServerRegionAndLoad("ingress", "ingress-1");

  const lifecycle = index.getServerLifecycle("ingress-1");
  assert.ok(lifecycle);
  assert.equal(lifecycle.phase, "ejected");
  assert.equal(lifecycle.connected, false);
  // State machine keeps last known region for diagnostics/traceability.
  assert.equal(index.resolveServerToRegion("ingress-1"), "local");
  assert.equal(index.isServerConnected("ingress-1"), false);

  assert.equal(index.hasRegion("local"), false);
  assert.equal(index.getLeastLoadedServerByMode("ingress", "local"), undefined);
});

test("server registry lifecycle: disconnected server retention is bounded", () => {
  const index = createRegistry({ maxDisconnectedServers: 2 });

  index.registerServer("ingress", "local", "active-ingress");
  index.setServerLoadSnapshot("ingress", "local", "active-ingress", 10, [10]);

  for (const serverId of ["old-1", "old-2", "old-3"]) {
    index.registerServer("ingress", "local", serverId);
    index.setServerLoadSnapshot("ingress", "local", serverId, 20, [20]);
    index.pruneServerRegionAndLoad("ingress", serverId);
  }

  const lifecycles = index.getServerLifecycles();
  const disconnectedLifecycles = lifecycles.filter(
    (lifecycle) => !lifecycle.connected,
  );
  assert.equal(index.isServerConnected("active-ingress"), true);
  assert.equal(disconnectedLifecycles.length, 2);
});

test("server registry lifecycle: prune fails loud when server region cannot be resolved", () => {
  const index = createRegistry();

  assert.throws(
    () => index.pruneServerRegionAndLoad("ingress", "missing-ingress"),
    /server region is unknown/,
  );
});
