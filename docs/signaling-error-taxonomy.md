# Signaling Error Taxonomy

This document defines the user-facing error codes emitted on the signaling websocket (`type: "error"`).

## Goals

- Keep client behavior deterministic.
- Separate user-correctable errors from internal failures.
- Make error handling and observability consistent across tests and runtime.

## Error Codes

| Code | Meaning | Typical Cause | Client Action |
|---|---|---|---|
| `invalidRegion` | Requested region is not configured in signaling | `requestIdentity` with unknown region | Prompt user to select a valid region; retry with known region |
| `roomEgressNotReady` | Room cannot serve media yet | Egress transport(s) not established for all joined peers | Retry media request after receiving `roomEgressReady` |
| `requestRejected` | Request violated protocol/state/ownership guardrails | Wrong peer ownership, invalid state transition, out-of-order request, missing mapping | Do not blind-retry; correct request sequencing/state first |
| `requestFailed` | Request failed for non-correctable server-side reason | Internal exception path or unavailable required backend resource | Surface failure to user and retry later; inspect server logs |

## Classification Rule

Signaling classifies websocket request failures as:

- `requestRejected` for guardrail and client-correctable errors.
- `requestFailed` for non-correctable/internal failures.

See `signaling/lib/signaling/websocketIngressFlow.ts` (`isRejectedRequestCategory` and `mapWebSocketRequestError`) for the canonical mapping logic.

## Stability Guidance

- Treat these codes as API contract for client behavior.
- Add new codes only when they represent a distinct user action path.
- Prefer preserving existing codes and refining `detail` text for diagnostics.
