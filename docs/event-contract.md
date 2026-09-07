# Herdr event contract

This is the authoritative Herdr wire-projection contract. [Architecture](architecture.md) describes ordering; [configuration](configuration.md) defines activation and lease eligibility; [feature ownership](feature-ownership.md) defines the authority boundary.

The extension consumes accepted `@pi/presence` V2 state, terminal, and withdraw events. Shared producer lifecycle, receipts, generation/sequence fences, withdrawal, and terminal encoding remain defined by the pinned [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260828-1/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260828-1/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260828-1/fixtures/normative.json).

## Pane projection

Every ordinary pane metadata render has exactly these ten keys:

- `summary`
- `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`
- `v2_terminals`, `v2_terminal_overflow`
- `tokens`, `cost`, `context`

Unavailable values are `null` except `summary`, which is always a bounded safe-derived grammar. The title is exactly `Pi · ${summary}`. `display_agent` is fixed to `Pi`; `state_labels` are fixed to `Pi is idle`, `Pi is working`, `Pi needs attention`, and `Pi state unknown`. No arbitrary context enters these fields.

The summary retains `working` or `idle` and may append the latest accepted terminal arrival as `terminal completed`, `terminal cancelled`, or `terminal failed`. Within the 80-byte/code-point budget, the state is always retained; space for the applicable V2 `input N` or terminal suffix is reserved first; then `progress`, positive `running`, positive `stopping`, and positive `queued` segments are attempted in that order before the reserved suffix is appended. Zero counts and lower-priority segments that do not fit are omitted. Blocked, input, and failure state take precedence over the transient terminal segment. A native-only TUI prompt uses the fixed `summary: "input"` while both V2 input tokens remain `null`. `v2_terminals` is independently canonically encoded and can have a different sort order. Terminal records, the terminal summary segment, and both terminal tokens clear together after `PI_HERDR_PRESENCE_FINAL_CLEAR_MS`.

## Mode-specific envelopes

| Mode | Ordinary metadata owner | Startup/teardown cleanup | Lifecycle authority |
| --- | --- | --- | --- |
| Standalone | `source: "herdr:pi"`, `applies_to_source: "herdr:pi"`, `agent: "pi"` | Current presentation + ten tokens, then separate 12-key legacy token cleanup | Reports and may clear `herdr:pi` session/state authority |
| Companion | `source: "herdr:pi-presence"`, `applies_to_source: "herdr:pi"` | Its current presentation + ten tokens only | Never reports or clears lifecycle/session authority directly |

Companion mode bridges aggregate native TUI prompt-or-accepted V2 `ask_user` waiting state to the managed integration through balanced in-process `herdr:blocked` events. It emits one fixed-label acquire on the absent-to-present transition and one release on the present-to-absent transition, replacement, or shutdown. The managed `herdr:pi` integration alone converts that lease into socket lifecycle reports; no question, option, or answer content is included.

## 네이티브 입력 집계

네이티브 `ui_prompt_start`는 프롬프트 본문·선택지·응답을 보관하거나 전송하지 않는다. 비동기 시작 중에는 세션 ID와 epoch에 묶인 불리언 대기 상태만 보관하고, 정확히 같은 TUI 세션이 활성화될 때만 채택한다. 교체·종료·비-TUI 또는 오래된 이벤트는 폐기한다. 네이티브 프롬프트와 수락된 V2 `ask_user`는 도착 순서와 관계없이 하나의 입력 수명주기로 집계된다. 알림 정책이 허용하면 이 수명주기는 고정된 `Pi needs your input` 제목과 본문으로 알림을 정확히 한 번만 낸다.

Both ordinary envelopes include `pane_id`, a process-coordinated `seq`, title, fixed display fields, and the exact ten-token map. Standalone startup sends the current metadata clear and separate legacy-token clear before session/state authority and ordinary metadata. Companion sends only its own current metadata clear before its ordinary metadata.

On teardown, after any standalone session-report attempt—including a lost or malformed response—the client first makes one priority, non-retried `pane.clear_agent_authority` attempt, then clears its current and legacy projection while the original lifecycle deadline allows. Companion clears only its own current presentation/token projection. Cleanup is best-effort and non-retried. The extension emits neither focus/control operations nor arbitrary text.

## Workspace lease envelope

Workspace metadata is separate from the ten pane tokens. An eligible attempt sends only:

```text
workspace_id, source: "herdr:pi-presence", seq, ttl_ms: 30000,
tokens: { main_summary }
```

It accepts only the exact `{ type: "ok" }` response. `main_summary` must use the same canonical bounded summary grammar as pane `summary`; no presentation fields or additional tokens are accepted. Each attempt first validates a bounded `pane.list` response scoped to the same workspace, including unique pane IDs and optional/nullable `agent` fields. It writes only if this runtime is the sole reported `agent: "pi"` pane.

The next attempt occurs 10 seconds after the prior attempt completes, not on every pane update. A list and write each have one five-second, no-retry budget. Workspace tokens are not source-cleared: ineligibility, error, replacement, and teardown let the 30-second TTL expire instead.

## Transport rules

Each request uses a fresh Unix-socket connection and receives one newline-delimited response. Requests and responses are schema-validated and bounded to 16 KiB. The normal lifecycle path has at most two bounded attempts; workspace writes and notifications have one. Lifecycle requests retain their caller's original absolute deadline through queueing and socket dispatch, so expired work is rejected before enqueue and again before drain. Actionable notification queue residency is bounded to `clamp(timeout_ms × (max_queue + 1), 1 s, 30 s)` and stays active through fingerprinting, connection, and final pre-write validation. A fresh configured socket-attempt timeout begins at dequeue, while `dispatched` is emitted only after `socket.write()` accepts the complete line without a synchronous throw. Queue disposition is exactly once after admission: `dispatched`, or released-before-dispatch as `timed_out`, `cancelled`, `pre_dispatch_failure`, `coalesced`, `priority_cleanup`, `actionable_displacement`, or `closed`. `pre_dispatch_failure` covers fingerprint, validation, connection, and other failures before the physical write; every released disposition rolls back its dedupe/rate reservation. Only outcomes after a successful physical `socket.write()` are committed, delivery-unknown, and never retried or rolled back. An active client suppresses only wire-equivalent, previously acknowledged ordinary `pane.report_agent` and `pane.report_metadata` projections (request IDs and `seq` are excluded) for five seconds; the next identical projection repairs a restarted or externally changed Herdr pane. Failed, malformed, stale, notification, session, workspace, and cleanup requests remain live. The bounded queue coalesces keyed work only within its protected, actionable, or replaceable lane. An actionable request can evict one queued replaceable item, but never protected/actionable work or active work; protected and actionable requests are preserved. Only priority cleanup bypasses ordinary admission and flushes queued work. Replacement or teardown lifecycle fences actively cancel outstanding notifications as well as the keyed replaceable workspace list and summary observers. Validation, serialization, and transport errors remain output-only.
