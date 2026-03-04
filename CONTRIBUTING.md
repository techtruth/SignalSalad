# Contributing

## Scope

Contributions should prioritize:

- developer-visible signaling/media correctness
- operational traceability
- deterministic tests for happy paths and failure paths

## Development Setup

```bash
make typecheck
make test
```

## Branch/PR Expectations

- Add or update tests for behavior changes.
- Update docs for contract/protocol/ops changes.
- Include risk notes for signaling/media state transitions.

## Testing Guidance

- Unit tests for pure logic and protocol mapping.
- Integration tests for multi-peer + multi-server sequencing.
- Full/runtime tests for process-level signaling behavior.

See `signaling/tests/README.md` and `docs/reliability.md`.
