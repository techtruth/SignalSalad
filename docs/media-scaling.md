# Media Scaling Model

This document defines how SignalSalad currently scales media across workers, servers, and regions.

## Objectives

- User media upload paths local to their region.
- User media download paths from the sending peer's region.
- Scale room capacity across multiple CPU workers on each media node.
- Scale room capacity across multiple servers using `PipeTransport`.
- Scale regions by adding more egress or ingress servers.
- Keep behavior deterministic for easier operations and debugging.
- Minimize cross-server relay duplication.

## Regional Topology

SignalSalad uses a regional ingress/egress split:

- publishers send media to regional `ingress`
- signaling coordinates relay to target regional `egress` nodes
- each `egress` fans out to local subscribers in-region

This keeps cross-region traffic to one relay path per destination region, instead of relaying per subscriber.

## Worker And Router Placement (Per Media Node)

Room scaling inside a media node is router-based.

- A room starts with one router group entry (`createRouterGroup`).
- New room routers are created lazily when existing room routers are all in active use.
- Router expansion uses least-loaded worker selection among workers not already used by that room.
- Worker load input is mediasoup worker resource usage (`ru_utime + ru_stime`) with room-assignment count as tie-break.

See `media/lib/sfuCore.ts` and `media/lib/sfuRelay.ts` for implementation.

## WebRTC Transport Placement (Per Room)

When creating ingress or egress WebRTC transports:

- the room router set may expand first (if needed)
- transport is assigned to the least-loaded room router (by active transport count)
- ties are deterministic: choose the router on the highest worker index
- if still tied, use router ID lexical order

This avoids non-deterministic tie behavior while still spreading a room across workers.

## Producer Visibility Across Room Routers

A producer is created on the router that owns the producing transport.

When a consumer transport is on a different router in the same room:

- the SFU ensures visibility by calling mediasoup `pipeToRouter(...)` on demand
- per-producer piped targets are tracked to avoid duplicate local pipes

So room fanout can span multiple routers/workers without requiring all consumers to be on the producer router.

## Inter-Server Relay Behavior

Across media servers, SignalSalad uses `networkpiperelay` control flow.

Current behavior:

- network pipe transports for room relay are anchored from the room's primary router entry
- producer/consumer local visibility across additional room routers is handled by local `pipeToRouter(...)`

This keeps inter-server relay wiring stable while allowing intra-node room distribution.

## Failure And Cleanup Semantics

- Missing producers/transports are treated as idempotent close paths.
- Router-group destroy cleans router state and associated room-scoped mappings.
- Producer/transport close events clear routing indexes to prevent stale fanout state.

## Tunables


- `MEDIA_WORKER_OMIT_CPUS`: Omit CPU for system tasks or other processes
  - worker count = `max(1, cpuCount - MEDIA_WORKER_OMIT_CPUS)`
  - default omit is `2`

## Current Constraints

- No active room downscale/rebalancing after expansion.
- Router load scoring is currently transport-count based (not bitrate/packet-rate weighted).
- Inter-server relay path is room-primary-router anchored.
