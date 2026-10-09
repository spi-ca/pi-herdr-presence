# 변경 이력

## v20261009-1

- Pi 개발 의존성과 현재 CI graph를 exact `1.1.0`으로 동기화했습니다. shared `@pi/presence`는 immutable `v2-20261009-1`로 고정하며, peeled commit·V2 protocol·ABI는 기존 `v2-20261004-1`과 같습니다.
- `agent_settled.aborted`를 같은 live/startup replay fence로 전달해 기존 `cancelled` outcome으로 처리합니다. 앞선 terminal 후보가 성공이어도 취소는 completion/failure 알림을 내지 않으며, 구형 event의 terminal derivation과 standalone/companion authority는 유지합니다. OSC 7501은 Pi 자체 기능으로 유지합니다.

## v20261004-1

- Shared `@pi/presence`를 immutable `v2-20261004-1`로 동기화했습니다. 기존 release와 peeled commit·V2 protocol·ABI는 같습니다.

- Synchronize exact Pi host development dependencies, lockfile, and baseline CI graph to `1.0.2`. Herdr protocol, presence output, and authority are unchanged.

## v20261001-1

- Update the compatibility baseline to Pi `0.99.2` and Herdr `v0.9.3`; protocol `22` and managed integration asset `9` are unchanged. Admit optional nullable `PaneInfo.restore_error` only as bounded ignored text; workspace selection and outgoing metadata are unchanged. No `resume_argv` is emitted.
- Pin the host development dependency and locked CI Pi graph to `0.99.2`, including `pi-codemode`/`pi-mcp`. Retain the older `0.85.1` regression lane, removing non-runtime `pi-client`/`pi-protocol` entries. The host peer remains `*`.
- Successful nested Todo results project aggregate counts only. Handled nested failures no longer poison the parent-turn failure fallback; a failed top-level parent still sets the failure fallback. Live and startup replay regressions cover both paths.
- CI regressions now wait for notification dispatch and completion-relative lease arming rather than assuming a received metadata request means later work has completed.
- Preserve the active long-running timer and accumulated working-time budget across `agent_end` continuations; final settlement, replacement, and shutdown still clear it. Regression tests cover live continuations, deferred next starts, and stalled-startup replay.

## v20260917-1

- Compatibility baseline is Herdr `v0.9.1` / protocol `22` and its managed Pi integration asset version `9`. The managed-marker and socket envelopes are unchanged; the reviewed v9 fixture adds Windows absolute session-path handling.

## v20260908-1

- Compatibility validation now admits only the exact recognized Herdr `v0.9.0` protocol-`22` `PaneInfo` fields within local bounds, rejects unknown fields, uses only `agent: "pi"` and `pane_id` for sole-Pi selection, and fails the workspace lease closed for malformed or oversized snapshots. The outgoing `main_summary` lease envelope remains unchanged.
- Documentation now distinguishes the Herdr application/protocol target (`v0.9.0`/`22`) from managed integration asset version `8`, and includes a conditional sidebar styling preset that conditionally styles existing emitted tokens while displaying built-in navigation tokens, without introducing a custom token.
- The manual real-Herdr smoke remains standalone-only and guarded as documented; no live Herdr `v0.9.0` smoke result is recorded in this release note.

## v20260907-2

- Bounded Todo/protocol validation and projection stability are reinforced; CI now verifies locked/current Pi graphs and runs a provider-free package smoke.

- Actionable notifications now have a finite queue-residency budget derived from timeout and queue capacity (clamped to 1–30 seconds), kept through fingerprint/connect/final pre-write validation alongside a fresh socket attempt begun at dequeue; only a successful `socket.write()` commits the reservation. Queue disposition is exactly once after admission; pre-write release rolls back transactional notification dedupe/rate reservations, while post-write delivery failures never do. Input lifecycles retain their exact pending key so short prompts cancel only their own pre-write toast; paired failure fallback is bounded, same-session fenced, and runs only after that release.

- Long-running notifications are explicitly local-only: `background` and `all` no longer allow an external source to trigger them, while external success/info eligibility is unchanged.
- Local long-running notifications now count only active parent-turn composite `working` time. Native/V2 input, blocked attention, and failure state pause one bounded remaining-time budget; settlement, agent end, replacement, and shutdown clear it. The one-per-turn long-running notice uses Herdr sound `none`; errors/input remain `request` and successful completion remains `done`.
- A live `failure:new` state and failed terminal now share a bounded, one-to-one notification identity only for the same source/generation with exactly adjacent accepted sequences within 100 ms. The correlator retains only the newest unmatched candidate per source; intervening same-source events, repeated failure kinds, semantic exits, non-failed terminals, withdrawals, generation changes, and session boundaries break correlation. The pinned V2 API has no producer deactivation/incarnation event, so silent same-source restarts remain conservatively indistinguishable inside that window.
- Nearby live failure-attention state and native/V2 input edges now arbitrate once to the fixed request-sound input alert in either arrival order only within the 10 ms input acceptance window and when the input alert passes policy, dedupe, and rate admission. Retained failures no longer block a new input lifecycle, while rejected input, later unrelated state-only failures, materially earlier already-notified failures, and failed terminal alerts remain separate.
- Bounded socket admission now protects actionable error/input notifications by evicting at most one queued replaceable metadata, workspace, or success-info item; it never aborts active work or displaces protected lifecycle/session or actionable requests. Priority cleanup remains the only flush-all path.
- Lifecycle start and shutdown now use one absolute configured timeout across authority-lane waiting and remote stages. Shutdown returns to Pi by that deadline while its reserved serialized cleanup later closes/releases ownership; expired startup and cleanup paths fence without new remote work.
- Ordinary acknowledged `pane.report_agent` and `pane.report_metadata` projections now deduplicate complete wire semantics per client (excluding request IDs and sequence). Failed, malformed, stale, notification, session, workspace, and cleanup work remains retryable/live.

- Companion mode now bridges aggregate accepted V2 `ask_user` waiting state through one balanced, fixed-label `herdr:blocked` lease. Retained replay acquires it, withdrawal releases it, and replacement or shutdown synchronously balances it while the managed `herdr:pi` integration remains the sole lifecycle reporter.
- Workspace heartbeat pacing now lives in `src/workspace-summary.ts`: each next 10-second attempt is scheduled after the prior publication completes, attempts do not overlap, and replacement/teardown fence pending or in-flight work without clearing the 30-second workspace lease.
- CI now runs Bun coverage through `scripts/check-coverage.ts`, requiring at least 85% function and 90% line coverage. The real-Herdr V2 producer harness moved to `scripts/live-herdr-presence-producers.ts`; it remains manual, standalone-only, disposable-pane guarded, requires metadata, effective notifications disabled, and adequate terminal retention, and is excluded from automatic CI.
- Socket/relay handling now adds per-request fingerprint rechecks, bounded one-line framing, timeout fences, and cancellation fences for active and newer queued same-key workspace requests during replacement or shutdown.
- Pi development types are pinned exactly to `@earendil-works/pi-coding-agent@0.84.4`; native `ui_prompt_start`/`ui_prompt_end` hooks now register directly through its `ExtensionAPI`. Native TUI prompt and accepted V2 `ask_user` waiting state remain one aggregated input lifecycle, while the non-optional peer range remains `*`.

- Workspace presence now requires an explicit opaque `HERDR_WORKSPACE_ID`, validates a scoped bounded, schema-faithful `pane.list`, and leases canonical `main_summary` from `herdr:pi-presence` only when this is the workspace's sole reported/detected Pi pane. Herdr `PaneInfo.agent` may be absent or `null`; only `agent: "pi"` counts. The 30-second lease attempts a refresh 10 seconds after completion, with fixed no-retry request budgets, and is never destructively cleared.

- Managed-hook detection now selects fail-closed automatic modes: exact managed presence uses `herdr:pi-presence` companion coexistence, exact absence uses standalone `herdr:pi` authority, and ambiguous probes disable output. `PI_HERDR_PRESENCE_SOLE_REPORTER` remains compatible but no longer gates standalone activation.
- Companion mode now applies the same fixed `Pi · ${summary}` title, fixed `display_agent`/`state_labels`, and exact ten-token metadata map under `herdr:pi-presence` to managed `herdr:pi`; it clears only that presentation/token metadata and may emit policy-gated static notifications. It never directly claims, reports, or clears session/lifecycle authority, legacy metadata, authority, focus/control, or arbitrary text.
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
