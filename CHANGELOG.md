# 변경 이력

## Unreleased

- Workspace heartbeat pacing now lives in `src/workspace-summary.ts`: each next 10-second attempt is scheduled after the prior publication completes, attempts do not overlap, and replacement/teardown fence pending or in-flight work without clearing the 30-second workspace lease.
- CI now runs Bun coverage through `scripts/check-coverage.ts`, requiring at least 85% function and 90% line coverage. The real-Herdr V2 producer harness moved to `scripts/live-herdr-presence-producers.ts`; it remains manual, standalone-only, disposable-pane guarded, requires metadata, effective notifications disabled, and adequate terminal retention, and is excluded from automatic CI.
- Socket/relay handling now adds per-request fingerprint rechecks, bounded one-line framing, timeout fences, and cancellation fences for active and newer queued same-key workspace requests during replacement or shutdown.
- Dependency alignment and documentation readability updates now follow the Pi `0.84.2` peer convention (`*`) with current development types/lock guidance, and clarify bounded Todo structural validation and non-projection boundaries.

- Workspace presence now requires an explicit opaque `HERDR_WORKSPACE_ID`, validates a scoped bounded, schema-faithful `pane.list`, and leases canonical `main_summary` from `herdr:pi-presence` only when this is the workspace's sole reported/detected Pi pane. Herdr `PaneInfo.agent` may be absent or `null`; only `agent: "pi"` counts. The 30-second lease attempts a refresh 10 seconds after completion, with fixed no-retry request budgets, and is never destructively cleared.

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
