# Architecture 5-Minute Tour

Fast orientation guide for SignalSalad.

## 1) What It Is

SignalSalad is a realtime media by room system with:

- reference/demo browser `SPA Client`
- `Signaling Service` control plane
- scaling `Ingress` + `Egress` media services

Reference: [C4 Level 1 - System Context](./c4-level1-system-context.md)

## 2) Runtime Building Blocks

Four primary runtime entities:

1. SPA Client
2. Signaling Service
3. Ingress Media Service
4. Egress Media Service

Reference: [C4 Level 2 - Container View](./c4-level2-container-view.md)

## 3) Network Boundaries

- Browser <-> Signaling: `WSS` (`/signaling`, `/status`)
- Signaling <-> Media services: `TCP netsocket`
- Browser <-> Media services: `WebRTC`
- Ingress <-> Egress: `networkpiperelay`

## 4) Where Control Logic Lives

- Main control-plane logic lives in the `Signaling Service`:
  - Entry + dispatch: `signaling/lib/signaling/signaling.ts`
  - Runtime wiring/composition: `signaling/lib/signaling/signalingRuntimeTopology.ts`
  - Request/callback routing: 
    - `signaling/lib/signaling/websocketIngressFlow.ts`
    - `signaling/lib/signaling/netsocketSignalFlow.ts`
    - `signaling/lib/signaling/flows/*`
  - Domain coordination: `signaling/lib/core/{peer,room,mediaServer}/*`

Reference: [C4 Level 3 - Signaling Code View](./c4-level3-signaling-components.md)

## 5) Where Media Logic Lives
- Shared signaling adapter (ingress + egress): `media/lib/mediaSignaling.ts`
- Shared SFU runtime core: `media/lib/sfuCore.ts`
- Shared network relay manager: `media/lib/sfuRelay.ts`
- Process entrypoint/bootstrap: `media/server.ts`

Reference:
  - [Ingress Code View](./c4-level3-ingress-code-view.md)
  - [Egress Code View](./c4-level3-egress-code-view.md)

## 6) Where Client Logic Lives
- Session orchestration/controller: `webapp/lib/controllers/mediasoupSessionController.ts`
- Controller state transitions: `webapp/lib/controllers/mediasoupSessionControllerState.ts`
- Signaling client adapter: `webapp/lib/signaling/mediaSignaling.ts`
- WebRTC transport + consumer tracking: `webapp/lib/signaling/mediaTransports.ts`, `webapp/lib/signaling/consumerRegistry.ts`
- UI panels and rendering: `webapp/lib/ui/*`

Reference: [C4 Level 3 - Webapp Code View](./c4-level3-webapp-code-view.md)

## 7) Deployment Placement
- [C4 Deployment View](./c4-deployment-view.md)

## Next

- Architecture docs: [Architecture](./README.md)
