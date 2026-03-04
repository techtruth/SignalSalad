# Media Lib Architecture

This folder contains the media-node runtime used by ingress and egress servers.

## Core Modules

- `sfuCore.ts`
  - Mediasoup SFU runtime wrapper (workers, routers, WebRTC transports, networkpiperelay, producers/consumers).
  - Owns media-plane lifecycle and router-group state.

- `mediaSignaling.ts`
  - Netsocket adapter between a media node and signaling.
  - Translates signaling commands into SFU actions and returns typed responses/events.
  - Reports periodic server load and handles registration/unregistration.

- `protocol/messageBuilders.ts`
  - Shared builders for media-side service/response/relay payloads.
  - Keeps wire-shape construction out of `mediaSignaling.ts`.

- `sfuDumpStats.ts`
  - Aggregates mediasoup transport/router stats into status-friendly totals.
  - Used for diagnostics/status snapshots, not control-plane decisions.

## Boundary Intent

- `mediaSignaling.ts` is the control-plane boundary.
- `sfuCore.ts` is the media-plane boundary.
- `sfuDumpStats.ts` is the observability boundary.

Keeping these separated makes failure handling and testing clearer:
- control-path failures are isolated from media internals,
- media internals can evolve without changing signaling contracts,
- status telemetry remains optional and non-blocking.

## Error Codes

Media nodes do not define user-facing websocket error codes directly. They return typed
netsocket responses/events and rely on signaling to map failures into stable client codes.

See:

- `docs/signaling-error-taxonomy.md`

## How To Extend Safely

When adding media features:

- Add or extend typed payloads first in `types/nsRelay.d.ts`.
- Keep control-path parsing/dispatch in `mediaSignaling.ts`; keep media-plane logic in `sfuCore.ts`.
- Treat inter-host relay behavior as `networkpiperelay`; reserve `pipetransport` wording for
  same-host router-to-router details only.
- Ensure new failure paths emit explicit responses/events so signaling can classify and surface them.

## Runtime Tunables

- `MEDIA_WORKER_OMIT_CPUS` (default: `2`)
  - Number of host CPUs intentionally left for non-media work when sizing mediasoup workers.
  - Worker count is computed as `max(1, cpuCount - MEDIA_WORKER_OMIT_CPUS)`.

## Scaling Reference

- Global scaling and fanout model: `docs/media-scaling.md`
- This file documents module boundaries; the scaling doc documents placement and relay policy.
