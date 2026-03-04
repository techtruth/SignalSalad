# Troubleshooting

## Troubleshooting Index

| Symptom | Start Here | Then |
| --- | --- | --- |
| User cannot join room | [Webapp Code View](./architecture/c4-level3-webapp-code-view.md) | [Signaling Code View](./architecture/c4-level3-signaling-components.md) |
| Websocket request rejected | [Signaling Code View](./architecture/c4-level3-signaling-components.md) | [Message Sequences](./message-sequences/README.md) |
| Media uploads fail | [Ingress Code View](./architecture/c4-level3-ingress-code-view.md) | [Container View](./architecture/c4-level2-container-view.md) |
| Remote media not received | [Egress Code View](./architecture/c4-level3-egress-code-view.md) | [Network Relay Handshake](./message-sequences/network-relay-handshake.md) |
| Relay setup/finalize fails | [Ingress Code View](./architecture/c4-level3-ingress-code-view.md) | [Egress Code View](./architecture/c4-level3-egress-code-view.md) |
| Regional/server placement confusion | [Deployment View](./architecture/c4-deployment-view.md) | [Container View](./architecture/c4-level2-container-view.md) |

## Symptoms and Fast Checks

### Peer cannot join room

- Check diagnostics for `websocketRequest` or `netsocketCommand` failures.
- Verify ingress and egress servers are registered in `systemStatus`.
- Confirm region is valid and has active server pools.

### Peer joined but cannot send media

- Verify ingress transport creation + connect callbacks were received.
- Check diagnostics for missing transport mapping or out-of-order connect requests.
- Confirm producer create callback exists for requested media kind.

### Peer sends media but others cannot receive

- Verify egress readiness and room attach state.
- Check fanout events (`createdConsumer`) and relay path diagnostics.
- Inspect diagnostics for orphan transport/producer close events.

### Intermittent failures after long sessions

- Look for socket close events before unregister.
- Check diagnostics for unknown producer owner / disconnected transport without peer mapping.
- Validate cleanup order for peer leave/disconnect.

## Debug Interface Usage

- Visually diagnose structural data-conduit issues (WebRTC transports, pipe transports, etc).
- Use peer filter to isolate one peer id.
- Use room filter to isolate one room.
- Read latest diagnostics entries first; they are chronological and timestamped.