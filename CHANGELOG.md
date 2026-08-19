# 변경 이력

## Unreleased

- Managed-hook detection now selects fail-closed automatic modes: exact managed presence uses `herdr:pi-presence` companion coexistence, exact absence uses standalone `herdr:pi` authority, and ambiguous probes disable output. `PI_HERDR_PRESENCE_SOLE_REPORTER` remains compatible but no longer gates standalone activation.
- Companion mode now applies the same fixed `Pi · ${summary}` title, fixed `display_agent`/`state_labels`, and exact ten-token metadata map under `herdr:pi-presence` to managed `herdr:pi`; it clears only that presentation/token metadata and may emit policy-gated static notifications. It never claims, reports, or clears session/lifecycle authority, legacy metadata, authority, focus/control, or arbitrary text.
- Terminal summaries now retain semantic `working`/`idle` and append the latest accepted arrival as `terminal completed`, `terminal cancelled`, or `terminal failed`; canonical `v2_terminals` encoding remains independent and both clear together.
- Shared dependency/imports were renamed to `@pi/presence` and pinned to `github:spi-ca/pi-presence#v2-20260818-2`.
- Herdr reporting now documents the fixed ten-token V2 projection, summary-derived title and fixed display fields in both modes, standalone versus companion envelopes and cleanup, managed authority fail-closed behavior, and privacy boundaries.
- Live V2 terminal failures, input-required lifecycles, and native/general blocked transitions again use bounded, policy-gated, non-retried static `notification.show` delivery. Retained activation replay remains silent, while accepted post-activation startup edges drain once in arrival order after the initial projection; overflow fails closed for notifications.
- Todo owner fencing now resets at root-session boundaries, allowing a new session to adopt a distinct Todo tool implementation while stale callbacks remain runtime-epoch fenced.
- Metadata now uses only reviewed Herdr v8 display fields and a title derived from the bounded safe `summary` token alongside the ten-token map, and explicitly clears presentation on teardown.
- The managed-marker test uses a committed fixture copied from the reviewed upstream active Herdr v8 Pi asset; real sibling-Herdr checks remain manual.
- Exact managed-file absence now selects standalone automatically; managed presence selects companion and unknown probes remain disabled. File probing cannot prove already-loaded cross-process authority.
- Startup queues derived lifecycle edges through cleanup and session authority, resets queued turn failure state at each `agent_start`, and coalesces repeated detached session starts.

## v0.1.0

- Initial Herdr-only release.
