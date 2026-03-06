# Threat Model Notes

## Assets

- room and peer control-plane state
- signaling transport integrity
- media transport coordination metadata

## Trust Boundaries

- browser websocket clients -> signaling
- media server netsocket connections -> signaling
- signaling orchestration -> room and producer registries

## Primary Risks

- spoofed or malformed control messages
- out-of-sequence callbacks causing stale state
- server identity/mode confusion on media registration paths
- accidental leakage of sensitive operational details

## Existing Mitigations

- explicit ownership and state-machine checks on websocket requests
- netsocket identity validation and mode consistency checks
- diagnostics without raw media payload content
- broad integration tests for sequencing and churn
