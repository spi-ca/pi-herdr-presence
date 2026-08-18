# 변경 이력

## Unreleased

- Shared dependency/imports were renamed to `@pi/presence` and pinned to `github:spi-ca/pi-presence#v2-20260818-2`.
- Herdr reporting now documents the fixed nine-token V2 projection, ID-only session references, managed authority fail-closed behavior, and privacy boundaries.
- Live V2 terminal failures, input-required lifecycles, and native/general blocked transitions again use bounded, policy-gated, non-retried static `notification.show` delivery; retained replay remains silent.
- Metadata now uses only reviewed Herdr v8 fixed presentation fields alongside the nine-token map and explicitly clears presentation on teardown.
- The managed-marker test uses a committed fixture copied from the reviewed upstream active Herdr v8 Pi asset; real sibling-Herdr checks remain manual.
- Local reporting now requires explicit `PI_HERDR_PRESENCE_SOLE_REPORTER=1` plus exact managed-file absence; stalled managed probes are deadline-bounded and lease-gated fail-closed.
- Startup queues derived lifecycle edges through cleanup and session authority, resets queued turn failure state at each `agent_start`, and coalesces repeated detached session starts.

## v0.1.0

- Initial Herdr-only release.
