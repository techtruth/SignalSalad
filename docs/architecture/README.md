# SignalSalad Architecture

Architecture and C4 model documentation.

## C4 Graphs At A Glance

| View | Purpose |
| --- | --- |
| Level 1 - System Context | External actors + system boundary |
| Level 2 - Container View | Runtime containers + protocol edges |
| Deployment View | Local/cloud placement model |
| Level 3 - Signaling | Control-plane routing and orchestration |
| Level 3 - Ingress | Ingress media control + relay source |
| Level 3 - Egress | Egress relay termination + fanout |
| Level 3 - Webapp | Browser session/media orchestration |
| Message Sequences | End-to-end request/callback stories |

## Quick Questions

- [Level 1 - System Context](./c4-level1-system-context.md): who uses SignalSalad and what does it do?
- [Level 2 - Container View](./c4-level2-container-view.md): What are the runtime containers and protocols between them?
- [Deployment View](./c4-deployment-view.md): What will this look like deployed on the cloud?
- [Scaling](../media-scaling.md): How do the media servers scale?
- [Level 3 - Signaling Code View](./c4-level3-signaling-components.md): How does signaling work?
- [Level 3 - Ingress Code View](./c4-level3-ingress-code-view.md): How do the ingress media servers work?
- [Level 3 - Egress Code View](./c4-level3-egress-code-view.md): How do the egress media servers work?
- [Level 3 - Webapp Code View](./c4-level3-webapp-code-view.md): How does the demo webapp work?
- [Message Sequences](../message-sequences/README.md): step-by-step request/callback stories.
- [Core Terms](#core-terms): shared architecture terms and naming conventions.

## Responsibility Matrix

| Concern | Primary Owner | Supporting Owner(s) | Main Docs |
| --- | --- | --- | --- |
| User session actions | SPA Client + Signaling Service | Ingress/Egress Media | Level 2, Signaling L3, Webapp L3 |
| Client transport setup (WebRTC) | SPA Client | Ingress/Egress Media | Webapp L3, Ingress/Egress L3 |
| Room/peer lifecycle | Signaling Service | SPA Client | Signaling L3, Message Sequences |
| Media relay orchestration | Signaling Service + Media Services | - | Signaling L3, Ingress/Egress L3 |

## Core Terms

- `SPA Client`: Browser app (`webapp`) that drives user session/media actions.
- `Signaling Service`: Control-plane service that routes requests and coordinates room/peer/media-server state.
- `Ingress Media Service`: Media node that receives upstream media from clients.
- `Egress Media Service`: Media node that sends downstream media to clients.
- `NetworkPipeRelay`: Ingress-to-egress relay path between media services.

## Signaling Internals

- `Signaling Facade`: Listener-facing entrypoint in `signaling.ts`.
- `Runtime Topology`: Composition root in `signalingRuntimeTopology.ts`.
- `Transport Wrappers`: Transport-specific request ingress handling (`websocketIngressFlow.ts`, `netsocketSignalFlow.ts`).
- `Flow Modules`: Request/callback routing modules (`signaling/lib/signaling/flows/*`).
- `Protocol Contracts`: Typed message builders + validators (`signaling/lib/protocol/*`).

## Transport Terms

- `WebSocket`: Client <-> signaling control channel (`/signaling`, `/status`).
- `Netsocket`: Signaling <-> media control channel (TCP).
- `Request Router`: Switch-style dispatch by message type.
- `Typed Error Response`: Protocol-level error payload with explicit message type/shape.
