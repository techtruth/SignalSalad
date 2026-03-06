# Reliability Profile

## Test Layers

- Unit: logic and mapping behavior
- Integration: sequencing across peers, rooms, signaling/media interactions
- Full: runtime process behavior and websocket/netsocket integration

Primary signaling suites:

- `0-peer`: media server registration lifecycle
- `1-peer`: full peer lifecycle and media start/stop/leave
- `2-peer`: peer discovery + fanout + control path
- `3-peer`: fanout correctness beyond pairwise interactions
- `10-peer`: timing variance and churn
- `100-peer`: high-cardinality sequencing and branch behavior
- `multi-region`: regional routing and capacity behavior across configured region pools (tests use `local`/`local-2`)
- `room-fanout-scale`: 99 peers across 33 rooms

## What Reliability Means Here

A run is considered healthy when:

- no protocol invariant violations are thrown
- expected join/attach/fanout transitions converge
- cleanup paths complete without stale transport/producer mappings
- diagnostics provide actionable failure reasons for user-impacting issues

## Current Limits (Practical)

- baseline coverage targets room control and signaling correctness, not media quality scoring
- stress tests focus on control-plane correctness under concurrency and churn (not media traffic)
- browser/device-specific codec/network variance is not fully modeled in integration tests

## Runbook Commands

- Full repo check path:
  - `make test`
- Signaling only:
  - `npm --prefix signaling run test:unit`
  - `npm --prefix signaling run test:integration`
  - `npm --prefix signaling run test:full`
- Media only:
  - `npm --prefix media run test:unit`
- Target one signaling integration suite file:
  - `npm --prefix signaling exec tsx --test tests/integration/signaling.zeroPeerLifecycle.test.ts`
  - `npm --prefix signaling exec tsx --test tests/integration/signaling.userImpactFailures.test.ts`

## Related Docs

- [Signaling happy-path matrix](../signaling/tests/signaling-happy-path-matrix.md)
- [Signaling error taxonomy](./signaling-error-taxonomy.md)
