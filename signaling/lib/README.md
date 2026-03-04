# Signaling Architecture

This folder contains the signaling server control plane. The code is grouped by responsibility so transport parsing, protocol contracts, peer lifecycle logic, and orchestration stay separated.

## File Structure
- `signaling/`
  - Orchestration and dispatch modules used by the main coordinator.
  - `signaling.ts`
    - Control-plane orchestrator only: wires dependencies, delegates dispatch, and bridges message flows.
  - `signalingRuntimeTopology.ts`
    - Runtime composition root (stores, policies, ports, and flow wiring).
  - `websocketIngressFlow.ts`
    - Websocket ingress handling and request-failure mapping.
  - `netsocketSignalFlow.ts`
    - Netsocket ingress handling and callback/request routing.
  - `signaling/flows/websocketRequestFlow.ts`
    - Websocket request dispatch table and domain-action mapping.
  - `signaling/flows/netsocketRequestFlow.ts`
    - Netsocket request dispatch table.
  - `signaling/flows/netsocketResponseFlow.ts`
    - Handlers for typed media-server callback/response payloads.

- `signaling/policies/`
  - Policy modules wired by `signaling/signalingRuntimeTopology.ts`.
  - `admissionPolicy.ts`
    - Controls whether a peer can be admitted at identity time.
    - Default behavior validates that requested region exists.
  - `roomMediaPolicy.ts`
    - Controls room-level media permissions.
    - Separates consume permissions (`allowRoomAudioRequest` / `allowRoomVideoRequest`) from publish permissions (`allowRoomAudioUpload` / `allowRoomVideoUpload`).
  - `webRTCTransportPolicy.ts`
    - Controls ingress/egress WebRTC transport operations.
    - Can independently allow/deny create/connect actions for ingress and egress transport flows.
  - `rateLimitPolicy.ts`
    - Controls request pacing for websocket request traffic.
    - Includes unlimited default policy plus fixed-window helper.
  - `types.ts`
    - Shared policy contracts and decision result shapes.

- `listeners/`
  - Edge listener adapters instantiated by `server.ts` (`websocket` + `netsocket` control-plane listeners).

- `core/peer/`
  - Peer domain: identity/session lifecycle, WebRTC transport lifecycle, media session flow, and producer registry.

- `core/room/`
  - Room domain: room routing/readiness state ownership and relay handshake flow.

- `core/mediaServer/`
  - Media-server domain: registration/load/ejection lifecycle and region/load selection state.

- `protocol/`
  - Shared protocol contracts/builders: typed message builders, runtime validators, routing/pipe type contracts, and messenger interface.

- `observability/`
  - Runtime observability: status snapshots, diagnostics buffer, and trace emitters.

## Module Map
- `signaling/signaling.ts`
  - Main signaling coordinator that wires listeners, core modules, protocol, and policies.
  - Owns orchestration only: websocket/netsocket request -> delegated dispatch/policy -> domain action -> websocket/netsocket response.

- `signaling/flows/websocketRequestFlow.ts`
  - Central websocket request dispatch table for all incoming client message types.

- `signaling/flows/netsocketRequestFlow.ts`
  - Central netsocket request dispatch table for all incoming media-server message types.

- `signaling/flows/netsocketResponseFlow.ts`
  - Typed response mapping from media-server callbacks to peer-facing websocket notifications.

- `signaling/websocketIngressFlow.ts`
  - Normalizes thrown websocket-request errors and maps them to stable protocol responses.

- `listeners/websocketServer.ts`
  - WebSocket listener and upgrade handling for browser clients.
  - `/signaling`
    - Accepts request messages from peers.
    - Parses JSON payloads, validates request shape, traces inbound messages, and forwards requests into signaling orchestration.
    - Routes handler failures to logs and closes invalid request streams.
  - `/status`
    - Read-only subscription channel for diagnostic/status snapshots.
    - Tracks status subscribers and ignores inbound request payloads.
  - Unknown websocket paths are rejected at upgrade with `404`.

- `listeners/netsocketServer.ts`
  - Media-server TCP signaling channel and typed send path for communication with media servers.
  - Handles server registration lifecycle, inbound media-node commands/events, and outbound control messages.

- `core/peer/peerWebRTCTransport.ts`
  - Browser ingress/egress transport request/create/connect/disconnect workflow.

- `core/room/roomRelay.ts`
  - Ingress<->egress networkpiperelay handshake coordination and downstream consumer trigger flow.

- `core/peer/peerMediaFanout.ts`
  - Collect -> plan -> dispatch consumer request flow, including per-egress grouping of already-routed producer entries.

- `core/peer/peerMediaSession.ts`
  - Peer media workflow coordinator (producer create/close/mute signaling and consumer orchestration).

- `core/mediaServer/serverRegistry.ts`
  - Server registry lifecycle/index owner (region/load indexes + server lifecycle record queries).

- `core/mediaServer/serverStateMachine.ts`
  - Server lifecycle transition model (`disconnected` -> `registered` -> `active` -> `ejected`).

- `core/mediaServer/mediaServer.ts`
  - Media-server runtime workflow coordinator (registration identity checks, socket-close ejection, room/server cleanup).

- `core/room/roomRoutingIndex.ts`
  - Room routing table + readiness index ownership and mutation lifecycle.

- `core/room/room.ts`
  - Room workflow owner for readiness broadcasts and room join routing requests.

- `core/room/roomStateMachine.ts`
  - Room lifecycle transition model (`empty` -> `routing` -> `egressPending` -> `ready`) used by room lifecycle state ownership.

- `observability/diagnosticsBuffer.ts`
  - In-memory diagnostic event buffer append/snapshot helpers.

- `core/peer/peer.ts`
  - Identity, room join/leave, disconnect, and room cleanup workflows.

- `core/peer/peerSessions.ts`
  - Peer session index owner (origin, transport, room-membership, and closing-state maps).

- `core/peer/peerStateMachine.ts`
  - Peer room/media state transitions and invariants.

- `core/peer/producerRegistry.ts`
  - Producer ownership, room index, and ingress affinity tracking.

- `protocol/netsocketMessageBuilders.ts`
  - Typed netsocket payload construction used for media-node requests.

- `protocol/websocketMessageBuilders.ts`
  - Typed websocket payload construction for transport response mapping.

- `protocol/websocketResponseBuilders.ts`
  - Typed websocket response payload construction used by signaling/core modules.

- `protocol/signalingIoValidation.ts`
  - Runtime payload validators and typed message maps.

- `protocol/signalingTypes.ts`
  - Shared signaling routing/pipe type contracts.

- `protocol/signalingMessenger.ts`
  - Typed messaging interface used by lifecycle/orchestration modules.

- `observability/statusReporter.ts`
  - Periodic status snapshot broadcaster for `/status` consumers.

- `observability/trace.ts`
  - Optional trace logging utilities (`SIGNAL_TRACE` gated).

- `core/mediaServer/serverLoadSelection.ts`
  - Region normalization and least-loaded server selection logic.

- `core/mediaServer/types.ts`
  - Shared media-server domain type contracts (mode, regional indexes, load indexes, selection result).

## Common Customization Points
- If you need auth/tenant access control
  - Start in `signaling/policies/admissionPolicy.ts`, then wire policy overrides via `signaling/signalingRuntimeTopology.ts` composition inputs.

- If you need to throttle abusive clients
  - Replace `defaultRateLimitPolicy` usage in `signaling/signalingRuntimeTopology.ts` with a stricter `createFixedWindowRateLimitPolicy(...)` profile.

- If you need feature-gated media behavior
  - Implement allow/deny rules in `signaling/policies/roomMediaPolicy.ts` and `signaling/policies/webRTCTransportPolicy.ts`.

- If you need richer status/debug feeds
  - Extend diagnostics in `observability/diagnosticsBuffer.ts` and status output in `observability/statusReporter.ts` (consumed by `/status` subscribers).
