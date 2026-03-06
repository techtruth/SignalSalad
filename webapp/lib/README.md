# WebApp Lib Architecture

This folder contains browser-side runtime code for signaling, media session orchestration, and UI rendering helpers.

## Layers

- `controllers/`
  - UI-facing session orchestration boundary (`MediasoupSessionController`).
  - Converts low-level signaling/media events into stable commands/events for UI code.
  - See `webapp/lib/controllers/README.md` for controller API details.

- `signaling/`
  - Browser signaling/media adapter internals.
  - Manages websocket signaling channels, mediasoup-client transports, and remote-consumer registries.
  - Intended to be consumed by controllers, not directly by UI panels.

- `ui/`
  - Rendering/view helpers for local/remote media and status visualization.
  - Should remain presentation-focused and avoid protocol/transport logic.

## Dependency Direction

UI panels -> controllers -> signaling internals

This direction keeps view code simple and avoids leaking transport/protocol complexity into UI components.

## Error Codes

Webapp signaling clients should treat websocket error codes as a stable contract emitted by signaling.

See:

- `docs/signaling-error-taxonomy.md`

## How To Extend Safely

When adding browser-side features:

- Add UI-facing behavior through `controllers/` first; avoid coupling UI directly to signaling internals.
- Extend `webapp/lib/signaling/` for protocol/transport changes, then surface only required events to UI.
- Keep inter-host relay terminology as `networkpiperelay`; do not use `pipetransport` unless describing
  same-host router-to-router internals.
- Prefer typed event additions over ad-hoc payload access in UI panels.
