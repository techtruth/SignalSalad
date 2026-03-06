# C4 Level 2 - Container View

- Browser-facing path: `End User -> SPA Client`
- Control path: `SPA Client -> Signaling (WSS /signaling)`
- Media path: `SPA Client -> Ingress/Egress Media (WebRTC)`

## Summarized Flow

1. End user interacts with SPA client.
2. SPA client uses signaling for control plane.
3. SPA client uses ingress/egress for media plane.
4. Signaling controls media services over netsocket.
5. Ingress connects to egress to share media over network relay.

## Regional Model

- Media runs as regional pools, not single nodes.
- Each region can have one or more `ingress` and one or more `egress` servers.
- Signaling coordinates which ingress/egress servers are used per peer and room.

```mermaid
C4Container
    title SignalSalad - Container View

    Person(user, "End User", "Human Actor")

    Container_Boundary(signalsalad_demo, "SignalSalad") {
        Container(spa_client, "SPA Client", "TypeScript/JavaScript", "Client application for signaling and media sessions")
        Container(signaling, "Signaling Service", "Node.js", "Coordinates room/peer state and media control messages")
        Container(ingress_service, "Ingress Media Service", "Node.js", "Regional service that receives user media")
        Container(egress_service, "Egress Media Service", "Node.js", "Regional service that fans out media to users")
    }

    UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="1")

    Rel(user, spa_client, "Browser", "HTTPS")
    UpdateRelStyle(user, spa_client, $offsetX="-60", $offsetY="-40")

    Rel(spa_client, signaling, "Session Control", "WSS /signaling")
    UpdateRelStyle(spa_client, signaling, $offsetX="-45", $offsetY="-40")

    Rel_D(spa_client, ingress_service, "Media Upload", "WebRTC")
    UpdateRelStyle(spa_client, ingress_service, $offsetX="-80", $offsetY="-10")

    Rel_U(spa_client, egress_service, "Media Download", "WebRTC")
    UpdateRelStyle(spa_client, egress_service, $offsetX="-40", $offsetY="-30")

    Rel_D(ingress_service, signaling, "Ingress Control", "TCP netsocket")
    UpdateRelStyle(signaling, ingress_service, $offsetX="90", $offsetY="-20")

    Rel_D(egress_service, signaling, "Egress Control", "TCP netsocket")
    UpdateRelStyle(signaling, egress_service, $offsetX="20", $offsetY="-25")

    Rel_R(ingress_service, egress_service, "NetworkRelay", "networkpiperelay")
    UpdateRelStyle(ingress_service, egress_service, $offsetX="-35", $offsetY="-35")
```

## Next

- Level 3 signaling code view: [C4 Level 3 - Signaling Code View](./c4-level3-signaling-components.md)
- Level 3 media and client code views:
  - [Ingress Code View](./c4-level3-ingress-code-view.md)
  - [Egress Code View](./c4-level3-egress-code-view.md)
  - [Webapp Code View](./c4-level3-webapp-code-view.md)
