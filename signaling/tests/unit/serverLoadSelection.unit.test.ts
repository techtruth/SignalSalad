/**
 * Why this file exists:
 * - Server selection behavior is a core scaling control plane concern.
 * - We need fast, pure checks for region normalization and least-load picking
 *   without websocket/netsocket integration harness setup.
 *
 * What this suite protects:
 * - case-insensitive region matching across ingress+egress pools.
 * - known-region checks for admission paths.
 * - server-to-region resolution semantics.
 * - least-loaded server picking behavior and region membership filtering.
 */
import assert from "node:assert/strict";
import test from "node:test";

import type { Guid } from "../../../types/baseTypes.d.ts";
import {
  hasKnownMediaServerRegion,
  pickLeastLoadedMediaServer,
  resolveMediaServerRegionLabel,
  resolveMediaServerRegion,
} from "../../lib/core/mediaServer/serverLoadSelection.js";

const createIndexes = () => ({
  ingressRegions: {
    local: ["ingress-a" as Guid, "ingress-b" as Guid],
    east: ["ingress-east" as Guid],
  },
  egressRegions: {
    local: ["egress-a" as Guid, "egress-b" as Guid],
    west: ["egress-west" as Guid],
  },
  ingressLoad: {
    local: {
      ["ingress-a" as Guid]: 30,
      ["ingress-b" as Guid]: 5,
      ["not-in-region" as Guid]: 1,
    },
    east: {
      ["ingress-east" as Guid]: 2,
    },
  },
  egressLoad: {
    local: {
      ["egress-a" as Guid]: 10,
      ["egress-b" as Guid]: 3,
    },
    west: {
      ["egress-west" as Guid]: 7,
    },
  },
});

test("server selection: resolveMediaServerRegionLabel normalizes case and trims whitespace", () => {
  const indexes = createIndexes();

  assert.equal(
    resolveMediaServerRegionLabel("  LoCaL  ", indexes.ingressRegions, indexes.egressRegions),
    "local",
  );
  assert.equal(
    resolveMediaServerRegionLabel(" WEST ", indexes.ingressRegions, indexes.egressRegions),
    "west",
  );
  assert.equal(
    resolveMediaServerRegionLabel("unknown-region", indexes.ingressRegions, indexes.egressRegions),
    "unknown-region",
  );
  assert.equal(
    resolveMediaServerRegionLabel("   ", indexes.ingressRegions, indexes.egressRegions),
    "",
  );
});

test("server selection: hasKnownMediaServerRegion checks both ingress and egress pools", () => {
  const indexes = createIndexes();

  assert.equal(
    hasKnownMediaServerRegion("EAST", indexes.ingressRegions, indexes.egressRegions),
    true,
  );
  assert.equal(
    hasKnownMediaServerRegion("west", indexes.ingressRegions, indexes.egressRegions),
    true,
  );
  assert.equal(
    hasKnownMediaServerRegion("unknown", indexes.ingressRegions, indexes.egressRegions),
    false,
  );
});

test("server selection: resolveMediaServerRegion maps server id from configured pools", () => {
  const indexes = createIndexes();

  assert.equal(
    resolveMediaServerRegion(
      "ingress-b",
      indexes.ingressRegions,
      indexes.egressRegions,
    ),
    "local",
  );
  assert.equal(
    resolveMediaServerRegion(
      "egress-west",
      indexes.ingressRegions,
      indexes.egressRegions,
    ),
    "west",
  );
  assert.equal(
    resolveMediaServerRegion(
      "missing-server",
      indexes.ingressRegions,
      indexes.egressRegions,
    ),
    undefined,
  );
});

test("server selection: pickLeastLoadedMediaServer filters to region membership", () => {
  const indexes = createIndexes();

  const selectedIngress = pickLeastLoadedMediaServer("ingress", "local", indexes);
  assert.equal(selectedIngress, "ingress-b");

  const selectedEgress = pickLeastLoadedMediaServer("egress", "LOCAL", indexes);
  assert.equal(selectedEgress, "egress-b");
});

test("server selection: pickLeastLoadedMediaServer handles missing mode/region indexes", () => {
  const indexes = createIndexes();

  assert.equal(
    pickLeastLoadedMediaServer("ingress", "south", indexes),
    undefined,
  );
  assert.equal(
    pickLeastLoadedMediaServer("egress", "north", indexes),
    undefined,
  );
});

test("server selection: tie result stays inside minimum-load candidate set", () => {
  const indexes = createIndexes();
  indexes.egressLoad.local = {
    ["egress-a" as Guid]: 4,
    ["egress-b" as Guid]: 4,
  };

  const selected = pickLeastLoadedMediaServer("egress", "local", indexes);
  assert.ok(selected === "egress-a" || selected === "egress-b");
});
