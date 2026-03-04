# Message Sequences

Mermaid sequence diagrams for protocol-level message flow between websocket clients, signaling, and media servers.

## Diagrams

- [All Systems Session Flow](./all-systems-session-flow.md)
- [Websocket Client <-> Signaling](./websocket-client-signaling.md)
- [Signaling <-> Media Server (Netsocket)](./signaling-mediaserver-netsocket.md)
- [Network Relay Handshake](./network-relay-handshake.md)

## Scope

- Message names match protocol contracts in `types/wsRelay.d.ts` and `types/nsRelay.d.ts`.
- Diagrams focus on control-plane signaling flow rather than RTP media-plane packet flow.
