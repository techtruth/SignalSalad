# Signaling Test Suite

This directory contains behavior-focused tests for the signaling server.

## Goals

1. Protect core room/peer/media lifecycle behavior from regressions.
2. Validate protocol guardrails (ownership, state ordering, registration rules).
3. Stress timing/order variance without relying on browser/runtime E2E.
4. Keep tests deterministic and fast so they are useful in daily development.

## Structure

- `unit/`
  - Pure module tests with mocked boundaries.
- `integration/`
  - High-value behavior scenarios centered around peer and media server interactions.
- `full/`
  - Runtime/process-level harness tests with real sockets/process startup.

## Integration Suite Map

- `integration/signaling.zeroPeerLifecycle.test.ts`
  - **Why**: Ensure media server registration lifecycle works even with no peers connected.
  - **Covers**: register/load/unregister behavior and no accidental websocket peer effects.

- `integration/signaling.netsocketIdentity.test.ts`
  - **Why**: Protect trust boundaries on media server netsocket commands.
  - **Covers**: required registration, duplicate identity rejection, reserved ID rejection, mode consistency, unregister semantics, offline-event TTL behavior.

- `integration/signaling.websocketRoomLifecycle.test.ts`
  - **Why**: Validate websocket identity + room attach/detach baseline before media complexity.
  - **Covers**: request identity, join/leave happy path, ownership/state guardrails.

- `integration/signaling.singlePeerFullCycle.test.ts`
  - **Why**: Validate full one-peer lifecycle including transport and producer actions.
  - **Covers**: identity/join, ingress+egress creation/connect, produce/close/re-produce, leave/disconnect, and key invalid-order failure paths.

- `integration/signaling.fullLogicJourney.test.ts`
  - **Why**: Validate one realistic multi-peer user journey from room entry through media actions and room exit.
  - **Covers**: identity/join, transport create/connect, publish/consume, media toggle on/off/on (producer close + re-produce), client/server mute actions, leave/rejoin continuity, producer close fanout, and final detach/disconnect cleanup.

- `integration/signaling.twoPeerSpecific.test.ts`
  - **Why**: Validate first multi-peer interaction semantics.
  - **Covers**: second join discovery/notifications, duplicate join rejection, two-peer full-cycle fanout and departure flow.

- `integration/signaling.twoPeerTiming.test.ts`
  - **Why**: Catch ordering bugs that appear when events arrive in different timing.
  - **Covers**: staggered identity/join convergence and out-of-order media request behavior.

- `integration/signaling.twoPeerControlPaths.test.ts`
  - **Why**: Exercise non-trivial coordinator/control transitions that can break silently.
  - **Covers**: relay coordination sequence, producer-close fanout, abrupt disconnect cleanup.

- `integration/signaling.threePeerLifecycle.test.ts`
  - **Why**: Validate first true fanout topology (one producer to multiple receivers).
  - **Covers**: 3-peer convergence and consumer planning/announcement for two downstream peers.

- `integration/signaling.tenPeerTiming.test.ts`
  - **Why**: Add broader timing/order confidence at moderate scale.
  - **Covers**: staggered 10-peer identity/join convergence and mixed graceful/abrupt departures without protocol errors.

- `integration/signaling.hundredPeerTiming.test.ts`
  - **Why**: Stress signaling sequencing with high-cardinality convergence plus deterministic complex traffic.
  - **Covers**: staggered 100-peer identity/join convergence, moderate-scale media request + leave/rejoin churn, and mixed graceful/abrupt departures.

- `integration/signaling.policies.test.ts`
  - **Why**: Ensure policy gate behavior remains consistent and deterministic.
  - **Covers**: signaling policy checks and expected accept/reject branches.

- `integration/signaling.systemStatusDiagnostics.test.ts`
  - **Why**: Validate diagnostics/status stream consistency for observability consumers.
  - **Covers**: status publication lifecycle and diagnostic emission expectations.

- `integration/signaling.scalingDistribution.test.ts`
  - **Why**: Protect server-selection and placement behavior under scaling inputs.
  - **Covers**: distribution characteristics across available media server pools.

- `integration/signaling.roomFanoutScale.test.ts`
  - **Why**: Validate room fanout behavior at larger room/cardinality profiles.
  - **Covers**: fanout correctness and control-plane stability for many room members.

- `integration/signaling.multiRegion.test.ts`
  - **Why**: Validate regional pool selection and cross-region room behavior.
  - **Covers**: case-insensitive region lookup, unknown-region rejection, regional capacity failure paths, and mixed multi-region convergence/flow behavior.

- `integration/serverRegistry.stateMachine.test.ts`
  - **Why**: Protect media server registry state transitions from regression.
  - **Covers**: registry state-machine transition correctness and guard behavior.

## Test Philosophy

- Use fake sockets/transports and direct command invocation for deterministic behavior.
- Validate externally observable protocol effects (messages/events/guards), not implementation detail.
- Add timing variance where ordering matters, keep baseline tests simple where it does not.
- Start from minimum topology (`0`, `1`, `2`, `3` peers), then add scale timing (`10` peers) for robustness.

## Commands

- `npm run test:unit`
- `npm run test:integration`
- `npm run test:full`
- `npm run test:all`
