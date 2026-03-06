# C4 Level 3 - Egress Media Service Code View

- Shows the egress execution path inside the shared media service codebase.
- Focuses on relay termination, egress transport lifecycle, and consumer provisioning.
- Same binaries are used for ingress/egress; this view isolates egress-specific behavior.

## Interface Summary

- Inputs:
  - Netsocket commands from signaling (relay/transport/consumer control).
- Outputs:
  - Netsocket responses/status callbacks to signaling.
  - WebRTC downstream media to browser peers.
- State Ownership:
  - Owns egress-side SFU runtime stores used for relay termination and fanout (`routerGroups`, `transports`, `networkPipeTransports`, `pipeProducers`).

## Behavior Notes

- `Egress Signaling Adapter` (`media/lib/mediaSignaling.ts`)
  - Owns netsocket lifecycle, decode/encode, registration, and outbound responses.
  - Feeds decoded requests into `incomingNetsocketSignal`.
- `Egress Request Handling` (`incomingNetsocketSignal` + egress handlers in `media/lib/mediaSignaling.ts`)
  - Switch-routes relay setup/finalize, egress transport lifecycle, consumer creation, and teardown commands.
  - Executes signaling-issued media cleanup (`teardownPeerSession`) without owning session lifecycle decisions.
- `SFU Core` (`media/lib/sfuCore.ts`)
  - Owns mediasoup workers/routers/transports/consumers and runtime state maps.
- `Network Pipe Manager` (`media/lib/sfuRelay.ts`)
  - Owns relay-specific pipe transport lifecycle and relay producer wiring.

## Summarized Flow

1. Netsocket adapter receives a signaling command.
2. Inbound request router dispatches by `payload.type`.
3. Egress request handling chooses behavior path.
4. SFU core and relay manager execute operations and update state.
5. Adapter emits response/status callbacks to signaling.

## Runtime Sequence

```mermaid
sequenceDiagram
    participant Sig as Signaling Service
    participant Adapter as Egress Signaling Adapter
    participant Handling as Egress Request Handling
    participant SFU as sfuCore + sfuRelay

    Sig->>Adapter: netsocket command
    Adapter->>Handling: decoded payload
    Handling->>SFU: execute operation
    SFU-->>Adapter: operation result
    Adapter-->>Sig: response/status callback
```

## Failure Sequence

### Relay Termination Setup Failure (Egress Side)

```mermaid
sequenceDiagram
    participant Sig as Signaling Service
    participant Adapter as Egress Signaling Adapter
    participant Handling as Egress Request Handling
    participant SFU as sfuCore + sfuRelay

    Sig->>Adapter: connectNetworkRelay/finalizeNetworkRelay
    Adapter->>Handling: decoded payload
    Handling->>SFU: attach relay/producer path
    SFU-->>Handling: failure (missing relay state)
    Handling-->>Adapter: relay failure result
    Adapter-->>Sig: response/status error callback
```

```mermaid
C4Component
    title SignalSalad - Egress Media Service (Level 3 Code View)

    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")

    Container_Ext(ingress_service, "Ingress Media Service", "Node.js", "Upstream relay source")
    Container_Ext(signaling_service, "Signaling Service", "Node.js", "Sends media control requests over netsocket")
    Container_Ext(browser_peer, "Browser Peer", "WebRTC client", "Receives audio/video from egress")

    Container_Boundary(egress_container, "Egress Media Service (Node.js, mode=egress)") {
        Component(pipe_manager, "Network Pipe Manager", "media/lib/sfuRelay.ts", "Attaches relay source and tracks per-room/server pipe links")
        Component(egress_signaling, "Media Signaling Adapter", "media/lib/mediaSignaling.ts", "Owns netsocket session and outbound/inbound payload framing")
        Component(sfu_core, "SFU Core", "media/lib/sfuCore.ts", "Workers, routers, transports, relay termination, consumers")
    }

    Rel(ingress_service, pipe_manager, "NetworkRelay", "networkpiperelay")
    UpdateRelStyle(ingress_service, pipe_manager, $offsetX="0", $offsetY="-40")
    Rel(egress_signaling, signaling_service, "Signaling Commands", "TCP netsocket")
    UpdateRelStyle(egress_signaling, signaling_service, $offsetX="-10", $offsetY="-60")
    Rel(browser_peer, sfu_core, "WebRTC Outbound", "DTLS/SRTP/ICE")
    UpdateRelStyle(browser_peer, sfu_core, $offsetX="-70", $offsetY="-60")

    Rel(egress_signaling, pipe_manager, "")
    Rel(egress_signaling, sfu_core, "Media server commands")
    UpdateRelStyle(egress_signaling, sfu_core, $offsetX="-70", $offsetY="50")

```

## Module Mapping

- `Egress Signaling Adapter`: `media/lib/mediaSignaling.ts`
- `Egress Request Handling`: `media/lib/mediaSignaling.ts` (`incomingNetsocketSignal` + command handlers)
- `SFU Core`: `media/lib/sfuCore.ts`
- `Network Pipe Manager`: `media/lib/sfuRelay.ts`
