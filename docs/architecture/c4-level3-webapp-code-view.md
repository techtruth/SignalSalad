# C4 Level 3 - Webapp (SPA Client) Code View

- Shows how UI modules, controller, signaling adapter, and transport helpers fit together.
- Focuses on runtime browser flow (not webpack build pipeline internals).
- Includes `ConsumerRegistry` because consumer tracking is client-side in this repo.
- Models the current demo UI implementation; long-term UI replacement is expected to keep the harness contract stable.

## Interface Summary

- Inputs:
  - User UI actions (join/leave/toggle/mute).
  - WebSocket events and media transport events.
- Outputs:
  - WebSocket requests to signaling.
  - WebRTC transport/media operations to ingress/egress services.
- State Ownership:
  - Owns browser session/controller state and client-side consumer tracking.

## Summarized Flow

1. UI panels emit user actions to session controller.
2. Controller updates state via reducer and calls signaling adapter.
3. Signaling adapter exchanges websocket messages with signaling service.
4. Transport helpers apply media transport updates.
5. UI panels render status/media updates.

## Primary Runtime Path

1. UI panels emit user actions to `Session Controller`.
2. Controller updates reducer state and calls signaling adapter.
3. Adapter drives websocket signaling and mediasoup transport helpers.
4. Transport helpers connect ingress/egress WebRTC paths.
5. Status and media events flow back to controller/UI panels.

## Runtime Sequence

```mermaid
sequenceDiagram
    participant User as End User
    participant UI as UI Panels
    participant Ctrl as Session Controller
    participant Adapter as Signaling Adapter
    participant Sig as Signaling Service
    participant Media as Ingress/Egress Media

    User->>UI: click join / media action
    UI->>Ctrl: command
    Ctrl->>Adapter: signaling call
    Adapter->>Sig: websocket request
    Sig-->>Adapter: response/event
    Adapter->>Media: transport/media operations
    Media-->>UI: remote/local media updates
```

## Failure Sequence

### Rejected Signaling Request

```mermaid
sequenceDiagram
    participant User as End User
    participant UI as UI Panels
    participant Ctrl as Session Controller
    participant Adapter as Signaling Adapter
    participant Sig as Signaling Service

    User->>UI: action (join/toggle)
    UI->>Ctrl: command
    Ctrl->>Adapter: signaling call
    Adapter->>Sig: websocket request
    Sig-->>Adapter: typed error response
    Adapter-->>Ctrl: rejected outcome
    Ctrl-->>UI: state/error update
```

```mermaid
C4Component
    title SignalSalad - Webapp / SPA Client (Level 3 Code View)

    UpdateLayoutConfig($c4ShapeInRow="5", $c4BoundaryInRow="1")

    Person(end_user, "End User", "Human actor using the browser UI")
    Container_Ext(blank_ext_a, "", "")
    Container_Ext(signaling_service, "Signaling Service", "Node.js", "Session control + status over websocket")
    Container_Ext(ingress_service, "Ingress Media Service", "Node.js", "Receives local media over WebRTC")
    Container_Ext(egress_service, "Egress Media Service", "Node.js", "Sends remote media over WebRTC")

    Container_Boundary(spa_container, "SPA Client (Browser Runtime)") {
        Component(ui_layer, "UI Panels", "ui/*", "User controls/click events")
        Component(session_controller, "Session Controller", "controllers/mediasoupSessionController.ts", "Client orchestration and state transitions")
        Component(blank_a, "", "")
        Component(blank_b, "", "")
        Component(blank_c, "", "")
        Component(blank_d, "", "")
        Component(blank_e, "", "")
        Component(signaling_adapter, "Signaling Adapter", "mediaSignaling.ts", "WebSocket signaling and event handling")
        Component(blank_f, "", "")
        Component(media_transport, "Media Transport Client", "mediaTransports.ts + consumerRegistry.ts", "WebRTC ingress/egress transport + consumer tracking")
    }

    UpdateElementStyle(blank_a, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_b, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_c, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_d, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_e, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_f, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_ext_a, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")

    Rel(signaling_adapter, signaling_service, "Session + status control", "WSS /signaling + /status")
    UpdateRelStyle(signaling_adapter, signaling_service, $offsetX="0", $offsetY="-150")
    Rel(media_transport, ingress_service, "Uploads media", "DTLS/SRTP/ICE")
    UpdateRelStyle(media_transport, ingress_service, $offsetX="-200", $offsetY="-150")
    Rel(media_transport, egress_service, "Downloads media", "DTLS/SRTP/ICE")
    UpdateRelStyle(media_transport, egress_service, $offsetX="0", $offsetY="-150")
    
    Rel(end_user, ui_layer, "Browser")
    UpdateRelStyle(end_user, ui_layer, $offsetX="-60", $offsetY="-50")
    Rel(ui_layer, session_controller, "Sends user commands")
    UpdateRelStyle(ui_layer, session_controller, $offsetX="-60", $offsetY="50")
    Rel(session_controller, signaling_adapter, "Delegates signaling/session actions")
    UpdateRelStyle(session_controller, signaling_adapter, $offsetX="-230", $offsetY="0")
    Rel(session_controller, media_transport, "Applies media transport actions")
```

## Module Mapping

- `UI Panels`: `webapp/lib/ui/*`
- `Session Controller`: `webapp/lib/controllers/mediasoupSessionController.ts`
- `Signaling Adapter`: `webapp/lib/signaling/mediaSignaling.ts`
- `Media Transport Client`: `webapp/lib/signaling/mediaTransports.ts`, `webapp/lib/signaling/consumerRegistry.ts`
