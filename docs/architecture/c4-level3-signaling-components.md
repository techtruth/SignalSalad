# C4 Level 3 - Signaling Code View

- Reflect signaling topology (listener adapters -> signaling facade -> runtime topology -> ingress wrappers -> flow modules -> core domains).
- Focuses on control-plane behavior: websocket/netsocket ingress handling, request routing, callback response mapping, room/peer/server lifecycle orchestration, and observability.

## Interface Summary

- Inputs:
  - WebSocket requests from SPA clients.
  - Netsocket callbacks/events from media services.
- Outputs:
  - WebSocket responses/events to SPA clients.
  - Netsocket commands to media services.
- State Ownership:
  - Owns control-plane lifecycle/state coordination for peer, room, and media-server domains.

## Summarized Flow

1. Listener adapters receive transport traffic (`WebSocket Server Adapter`, `Netsocket Server Adapter`).
2. `Signaling Facade` forwards lifecycle and message handling into the composed runtime.
3. `Runtime Topology` wires ingress wrappers + flow modules.
4. Flow modules invoke core domains and protocol contracts.
5. Observability collects diagnostics/status from ingress wrappers and runtime wiring.

## Networked Message Exchange

```mermaid
flowchart LR
    A[WebSocket Requests\nprotocol/signalingIoValidation.ts: WsRequestMap]
    B[WebSocket Responses\nprotocol/signalingIoValidation.ts: WsMessageMap]
    C[Netsocket Commands Outbound\nprotocol/signalingIoValidation.ts: NsMessageMap]
    D[Netsocket Callbacks Inbound\nprotocol/signalingIoValidation.ts: MediaInboundMessageMap]

    A -->|validated + routed| E[Flow Modules]
    E -->|build/send| B
    E -->|build/send| C
    D -->|validated + routed| E
```

## Runtime Sequence

```mermaid
sequenceDiagram
    participant Client as SPA Client
    participant WS as WebSocket Adapter
    participant Facade as signaling.ts
    participant Wrap as websocketIngressFlow
    participant Flow as websocketRequestFlow
    participant Domain as peer/room/mediaServer core
    participant Proto as protocol builders/messenger

    Client->>WS: request (WSS /signaling)
    WS->>Facade: incomingWebsocketSignal
    Facade->>Wrap: handle(wsid, signal)
    Wrap->>Flow: dispatch(signal)
    Flow->>Domain: invoke action
    Domain->>Proto: build/send typed output
    Proto-->>WS: outbound websocket message
    WS-->>Client: response/event
```

## Failure Sequences

### Rejected WebSocket Request

```mermaid
sequenceDiagram
    participant Client as SPA Client
    participant WS as WebSocket Adapter
    participant Facade as signaling.ts
    participant Wrap as websocketIngressFlow
    participant Flow as websocketRequestFlow
    participant Proto as protocol builders/messenger

    Client->>WS: malformed/invalid request
    WS->>Facade: incomingWebsocketSignal
    Facade->>Wrap: handle(wsid, signal)
    Wrap->>Flow: dispatch(signal)
    Flow-->>Wrap: validation/policy rejection
    Wrap->>Proto: build typed error response
    Proto-->>WS: websocket error payload
    WS-->>Client: rejected request response
```

### Recoverable Netsocket Callback Drift

```mermaid
sequenceDiagram
    participant Media as Media Server
    participant NS as Netsocket Adapter
    participant Facade as signaling.ts
    participant Wrap as netsocketSignalFlow
    participant Flow as netsocketResponseFlow
    participant Obs as observability/trace

    Media->>NS: callback with stale/unknown opId
    NS->>Facade: incomingNetsocketSignal
    Facade->>Wrap: handle(connectionId, signal)
    Wrap->>Flow: route callback
    Flow-->>Wrap: callback miss (no pending operation)
    Wrap->>Obs: emit drift diagnostic
    Wrap-->>NS: no fatal teardown
    NS-->>Media: continue session
```

```mermaid
C4Component
    title SignalSalad - Signaling Service Components

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

    Container_Ext(spa_client, "SPA Client", "TypeScript/JavaScript", "User in Browser")
    Container_Ext(ingress_service, "Ingress Media Service", "Node.js", "Multiple Nodes")
    Container_Ext(egress_service, "Egress Media Service", "Node.js", "Multiple Nodes")

    Container_Boundary(signaling_container, "Signaling Service (Node.js)") {
        Component(ws_server, "WebSocket Server", "websocketServer.ts", "Listens for Websocket")
        Component(blank_a, "", "")
        Component(ns_server, "Netsocket Server", "netsocketServer.ts", "Listens for Netsocket")
        Component(blank_b, "", "")
        
        Component(signaling_facade, "Signaling Facade", "signaling.ts", "Listener-facing entrypoint and outbound dispatch")
        Component(blank_c, "", "")
        
        Component(runtime_orchestration, "Runtime Orchestration", "signalingRuntimeTopology.ts", "policies, flows, and datastructs")
        Component(blank_d, "", "")
       
        
        Component(request_flows, "Request Flows", "websocketIngressFlow.ts + netsocketSignalFlow.ts + flows/*", "Websocket/netsocket request routing and callback mapping")
        Component(blank_e, "", "")
        
        Component(domain_services, "Domain Entities", "core/{peer,room,mediaServer}/*", "Peer, room, and media-server lifecycle/state coordination")
        Component(blank_f, "", "")
        Component(blank_g, "", "")
    }


    Rel(spa_client, ws_server, "Peer Session", "WSS /signaling")
    UpdateRelStyle(spa_client, ws_server, $offsetX="10", $offsetY="-40")
    Rel(ingress_service, ns_server, "Media control", "TCP netsocket")
    UpdateRelStyle(ingress_service, ns_server, $offsetX="-50", $offsetY="-40")
    Rel(egress_service, ns_server, "Media control", "TCP netsocket")
    UpdateRelStyle(egress_service, ns_server, $offsetX="0", $offsetY="-40")

    Rel(ws_server, signaling_facade, "Websocket requests")
    Rel(ns_server, signaling_facade, "Netsocket commands")
    UpdateRelStyle(ns_server, signaling_facade, $offsetX="20", $offsetY="0")

    Rel(signaling_facade, runtime_orchestration, "Delegates to runtime")
    UpdateRelStyle(signaling_facade, runtime_orchestration, $offsetX="30", $offsetY="0")

    Rel(runtime_orchestration, request_flows, "Builds and wires flows")
    UpdateRelStyle(runtime_orchestration, request_flows, $offsetX="-60", $offsetY="-10")

    Rel(runtime_orchestration, domain_services, "Builds and wires domains")

    Rel(request_flows, domain_services, "Routes control actions")
    UpdateRelStyle(request_flows, domain_services, $offsetX="40", $offsetY="0")


    UpdateElementStyle(blank_a, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_b, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_c, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_d, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_e, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_f, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
    UpdateElementStyle(blank_g, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
```

## Module Mapping

- `WebSocket Server Adapter`: `signaling/lib/listeners/websocketServer.ts`
- `Netsocket Server Adapter`: `signaling/lib/listeners/netsocketServer.ts`
- `Signaling Facade`: `signaling/lib/signaling/signaling.ts`
- `Runtime Orchestration`: `signaling/lib/signaling/signalingRuntimeTopology.ts`
- `Request Flows`:
  - `signaling/lib/signaling/websocketIngressFlow.ts`
  - `signaling/lib/signaling/netsocketSignalFlow.ts`
  - `signaling/lib/signaling/flows/websocketRequestFlow.ts`
  - `signaling/lib/signaling/flows/netsocketRequestFlow.ts`
  - `signaling/lib/signaling/flows/netsocketResponseFlow.ts`
- `Domain Services`:
  - `signaling/lib/core/peer/*`
  - `signaling/lib/core/room/*`
  - `signaling/lib/core/mediaServer/*`
- `Protocol + Observability`:
  - `signaling/lib/protocol/*`
  - `signaling/lib/observability/*`

## Message Sequences

- [All Systems Session Flow](../message-sequences/all-systems-session-flow.md)
- [Network Relay Handshake](../message-sequences/network-relay-handshake.md)
