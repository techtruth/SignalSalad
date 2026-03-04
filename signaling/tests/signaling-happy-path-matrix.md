# Signaling Test Matrix: Happy Paths + Happy-Path Failures

## Scope
- Focus only on:
  - happy path scenarios
  - failures that branch directly from those same flows
- Excludes:
  - region-routing variants
  - load/perf stress
  - browser/media RTP runtime

## Standard Scenario Shape
- `Given`: starting topology/state
- `When`: ordered client/media actions
- `Then`: expected outputs + state invariants
- `Fail Branches`: minimal deviations from the same `When` sequence

## P0 Flows (implement first)

### 1) Media Server Lifecycle (Control Plane)
- Happy path:
  - ingress/egress register
  - send serverLoad
  - graceful unregister
- Assert:
  - identity bound to connection
  - load accepted only for registered identity/mode
  - unregister ejects + socket end + offline event
- Failure branches:
  - non-register message before register
  - duplicate server id on different connection
  - mode mismatch on same connection
  - spoofed node id on registered connection

### 2) Peer Identity + Room Join
- Happy path:
  - peer requests identity
  - peer joins room
- Assert:
  - peer enters joined state
  - room membership index updated
  - joined reply sent
- Failure branches:
  - join without identity mapping
  - duplicate join to same room
  - join while still in incompatible state

### 3) Ingress Setup + Produce
- Happy path:
  - createIngress
  - connectIngress
  - produceMedia
- Assert:
  - correct netsocket messages to ingress
  - peer media state moves to ready
  - producer registry updated
- Failure branches:
  - connectIngress before createIngress
  - produceMedia before ingress connected
  - duplicate createIngress for same peer lifecycle phase

### 4) Egress Setup + Consumer Fanout (Two Peers)
- Happy path:
  - peer A produces
  - peer B joins and creates/connects egress
  - consumer creation is requested and acknowledged
- Assert:
  - expected createConsumer path triggered
  - producer->consumer mapping consistent
  - peer B receives consumer-ready websocket responses
- Failure branches:
  - createEgress before join
  - connectEgress before createEgress
  - missing egress server identity when fanout requested

### 5) Producer Close + Cleanup
- Happy path:
  - producerClose from producer peer
  - downstream peers notified
  - registry/session mappings cleaned
- Assert:
  - producer removed from registry
  - `producerClosed` forwarded to room peers
  - no orphan producer references in pipes
- Failure branches:
  - close unknown producer id
  - close producer from wrong origin/peer

### 6) Peer Exit Paths
- Happy path:
  - graceful leave/disconnect request
  - transports/producers cleaned
  - room cleanup if last peer
- Assert:
  - no peer/session transport leftovers
  - room indices cleaned
- Failure branches:
  - abrupt websocket close (no graceful message)
  - cleanup attempts for already-removed peer are idempotent

## P1 Flows (after P0)

### 7) Media Server Abrupt Disconnect
- Happy path equivalent:
  - graceful unregister path already covered in P0
- Failure branch:
  - registered media server socket closes unexpectedly
- Assert:
  - server ejected with `graceful=false`
  - affected peers removed/cleaned
  - offline event recorded with socket-closed reason

### 8) Status Stream Consistency
- Happy path:
  - status subscriber connects
  - receives periodic coherent snapshots
- Failure branches:
  - no subscribers => reporter stopped
  - stale offline events pruned by TTL

## Test Naming Convention
- `flow_expectedBehavior`
- examples:
  - `mediaServerLifecycle_registerLoadUnregister_success`
  - `mediaServerLifecycle_duplicateServerId_rejected`
  - `ingressSetup_connectBeforeCreate_rejected`

## Implementation Order
1. Extend existing netsocket identity/lifecycle tests (already started)
2. Add peer join + ingress happy/failure tests
3. Add two-peer fanout happy/failure tests
4. Add producer close + peer exit tests
5. Add abrupt media disconnect + status consistency tests

