# C4 Level 3 - Ingress Media Service Code View

- Shows the ingress execution path inside the shared media service codebase.
- Focuses on direct code responsibilities and module boundaries.
- Same binaries are used for ingress/egress; this view isolates ingress-specific behavior.

## Interface Summary

- Inputs:
  - Netsocket commands from signaling (ingress control operations).
- Outputs:
  - Netsocket responses/status callbacks to signaling.
  - WebRTC media ingest from browser peers.
- State Ownership:
  - Owns ingress-side SFU runtime stores (`routerGroups`, `transports`, `producers`, `networkPipeTransports`, `pipeProducers`).

## Summarized Flow

1. Netsocket adapter receives a signaling command.
2. Inbound request router dispatches by `payload.type`.
3. Ingress operation handlers invoke SFU core operations.
4. SFU core updates transport/router/producer state.
5. Adapter emits response/status callbacks to signaling.

## Runtime Sequence

```mermaid
sequenceDiagram
    participant Sig as Signaling Service
    participant Adapter as mediaSignaling
    participant Router as incomingNetsocketSignal
    participant Ops as Ingress Operation Handlers
    participant SFU as sfuCore.ts

    Sig->>Adapter: netsocket command
    Adapter->>Router: decoded payload
    Router->>Ops: route by payload.type
    Ops->>SFU: execute ingress operation
    SFU-->>Adapter: operation result
    Adapter-->>Sig: netsocket response/callback
```

## Failure Sequence

### Relay Setup Failure (Ingress Side)

```mermaid
sequenceDiagram
    participant Sig as Signaling Service
    participant Adapter as mediaSignaling
    participant Router as incomingNetsocketSignal
    participant Ops as Ingress Operation Handlers
    participant SFU as sfuCore.ts

    Sig->>Adapter: finalizeNetworkRelay/connectNetworkRelay
    Adapter->>Router: decoded payload
    Router->>Ops: route relay operation
    Ops->>SFU: create/connect relay resources
    SFU-->>Ops: failure (router/pipe unavailable)
    Ops-->>Adapter: relay failure result
    Adapter-->>Sig: netsocket error/status callback
```

```mermaid
C4Component
    title SignalSalad - Ingress Media Service (Level 3 Code View)

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
    Container_Ext(egress_service, "Egress Media Service", "Node.js", "Downstream relay destination")
    Container_Ext(signaling_service, "Signaling Service", "Node.js", "Sends media control requests over netsocket")
    Container_Ext(browser_peer, "Browser Peer", "WebRTC client", "Publishes audio/video to ingress")

    Container_Boundary(ingress_container, "Ingress Media Service (Node.js, mode=ingress)") {
        Component(pipe_manager, "Network Pipe Manager", "media/lib/sfuRelay.ts", "Ingress-side create/consume/finalize of networkpiperelay")
        Component(ingress_signaling, "Media Signaling Adapter", "media/lib/mediaSignaling.ts", "Owns netsocket session and outbound/inbound payload framing")
        Component(sfu_core, "SFU Core", "media/lib/sfuCore.ts", "Workers, routers, transports, producers, networkpiperelay operations")
    }

    
    Rel(egress_service, pipe_manager, "NetworkRelay", "networkpiperelay")    
    UpdateRelStyle(egress_service, pipe_manager, $offsetX="-20", $offsetY="-60")
    Rel(browser_peer, sfu_core, "WebRTC Inbound", "DTLS/SRTP/ICE")    
    UpdateRelStyle(browser_peer, sfu_core, $offsetX="-70", $offsetY="-60")
    Rel(ingress_signaling, signaling_service, "Signaling Commands", "TCP Netsocket")    
    UpdateRelStyle(ingress_signaling, signaling_service, $offsetX="-10", $offsetY="-60")

    Rel(ingress_signaling, pipe_manager, "")
    UpdateRelStyle(ingress_signaling, sfu_core, $offsetX="-70", $offsetY="50")    
    Rel(ingress_signaling, sfu_core, "Media server commands")
    UpdateRelStyle(ingress_signaling, sfu_core, $offsetX="-70", $offsetY="50")






```

## Module Mapping

- `Media Signaling Adapter`: `media/lib/mediaSignaling.ts`
- `SFU Core`: `media/lib/sfuCore.ts`
- `Network Pipe Manager`: `media/lib/sfuRelay.ts`
