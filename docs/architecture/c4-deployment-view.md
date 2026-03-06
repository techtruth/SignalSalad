# C4 Deployment View

- Shows where runtime containers are placed in local dev and cloud regions.
- Shows deployment-time relationships between signaling and regional media pools.
- Omits code-level module wiring (covered in Level 3 code views).

```mermaid
C4Deployment
    title SignalSalad - Deployment View
    UpdateLayoutConfig($c4ShapeInRow="2", $c4BoundaryInRow="3")

    Deployment_Node(tencent_cloud, "Tencent Cloud", "Multi-region CVM deployment") {

        Deployment_Node(WebHost, "WebHost", "COS + CDN") {
            Container(webapp_cos, "Cloud Object Storage", "COS", "Static copy of webapp's dist folder")
            Container(webapp_cdn, "Content Distribution Network", "CDN", "Edge cached for quick load times")
            Rel(webapp_cos, webapp_cdn, "Content Cache", "Encrypted")
            UpdateRelStyle(webapp_cos, webapp_cdn, $offsetX="0", $offsetY="-20")
            
        }

        Deployment_Node(sig_region, "Signaling Silicon Valley Region", "CVM + VPC/Subnet + SG") {
            Container(signaling_cloud, "Signaling Service", "Node.js container", "Session/peer control over WSS + TCP 1188")
        }

        Deployment_Node(blank_region_a, "", "") {
            UpdateElementStyle(blank_region_a, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
            Container(blank_a, "", "", "")
            UpdateElementStyle(blank_a, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
        }


        Deployment_Node(media_virginia_region, "Media Virginia Region", "CVM + VPC/Subnet + SG") {
            Container(ingress_virginia, "Ingress Media Service Pool", "Node.js containers", "Receives client media and initiates relays")
            Container(egress_virginia, "Egress Media Service Pool", "Node.js containers", "Consumes relay and fanouts to peers")
        }

        Deployment_Node(blank_region_b, "", "") {
            UpdateElementStyle(blank_region_b, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
            Container(blank_b, "", "", "")
            UpdateElementStyle(blank_b, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
        }



        Deployment_Node(media_guangzhou_region, "Media Guangzhou Region", "Per-region CVM + VPC/Subnet + SG") {
            Container(ingress_guangzhou, "Ingress Media Service Pool", "Node.js containers", "Receives client media and initiates relays")
            Container(egress_guangzhou, "Egress Media Service Pool", "Node.js containers", "Consumes relay and fanouts to peers")
        }

        Deployment_Node(blank_region_c, "", "") {
            UpdateElementStyle(blank_region_c, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
            Container(blank_c, "", "", "")
            UpdateElementStyle(blank_c, $bgColor="transparent", $borderColor="transparent", $fontColor="transparent")
        }


        Deployment_Node(tcr, "Tencent Container Registry", "TCR") {
            Container(tcr_signaling, "Signaling Image", "signaling image", "Pulled during deployment/runtime")
            Container(tcr_media, "Media Image", "SFU", "Pulled during deployment/runtime")
        }


    }

    Rel(webapp_cdn, signaling_cloud, "Signaling control", "WSS")
    UpdateRelStyle(webapp_cdn, signaling_cloud, $offsetX="-65", $offsetY="25")
    

    Rel(ingress_virginia, signaling_cloud, "Ingress control", "TCP netsocket")
    UpdateRelStyle(ingress_virginia, signaling_cloud, $offsetX="-245", $offsetY="195")
    Rel(egress_virginia, signaling_cloud, "Egress control", "TCP netsocket")
    UpdateRelStyle(egress_virginia, signaling_cloud, $offsetX="-150", $offsetY="270")
    Rel(ingress_virginia, egress_virginia, "NetworkPipeRelay", "networkpiperelay")
    UpdateRelStyle(ingress_virginia, egress_virginia, $offsetX="-110", $offsetY="-10")


    Rel(ingress_guangzhou, signaling_cloud, "Ingress control", "TCP netsocket")
    UpdateRelStyle(ingress_guangzhou, signaling_cloud, $offsetX="180", $offsetY="195")
    Rel(egress_guangzhou, signaling_cloud, "Egress control", "TCP netsocket")
    UpdateRelStyle(egress_guangzhou, signaling_cloud, $offsetX="60", $offsetY="270")
    Rel(ingress_guangzhou, egress_guangzhou, "NetworkPipeRelay", "networkpiperelay")
    UpdateRelStyle(ingress_guangzhou, egress_guangzhou, $offsetX="5", $offsetY="-10")


   Rel(tcr_signaling, signaling_cloud, "Pull Image", "Docker")
   UpdateRelStyle(tcr_signaling, signaling_cloud, $offsetX="5", $offsetY="300")

   Rel(tcr_media, ingress_guangzhou, "Pull Image", "Docker")
   Rel(tcr_media, egress_guangzhou, "Pull Image", "Docker")
   UpdateRelStyle(tcr_media, ingress_guangzhou, $offsetX="-90", $offsetY="-50")
   UpdateRelStyle(tcr_media, egress_guangzhou, $offsetX="0", $offsetY="-30")


   Rel(tcr_media, ingress_virginia, "Pull Image", "Docker")
   Rel(tcr_media, egress_virginia, "Pull Image", "Docker")
   UpdateRelStyle(tcr_media, ingress_virginia, $offsetX="30", $offsetY="-50")
   UpdateRelStyle(tcr_media, egress_virginia, $offsetX="-60", $offsetY="-30")
```

## Out Of Scope

- Request/response control flows (Level 3 + Message Sequences).
- Browser UI behavior and state flow (Webapp Level 3).

## Notes

- Local deployment corresponds to `containerization/docker-compose.yml`.
- Cloud deployment applies to AWS/Tencent/Azure.
- Media can scale independently; media is modeled as regional pools.

## Next

- Container interactions: [C4 Level 2 - Container View](./c4-level2-container-view.md)
- Signaling internals: [C4 Level 3 - Signaling Code View](./c4-level3-signaling-components.md)
