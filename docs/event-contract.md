# Herdr event contract

This is the authoritative Herdr wire-projection contract. [Architecture](architecture.md) describes ordering; [configuration](configuration.md) defines activation and lease eligibility; [feature ownership](feature-ownership.md) defines the authority boundary. The current Herdr target is application `v0.9.5`, protocol `22`; this is separate from managed integration asset `HERDR_INTEGRATION_VERSION=9`.

The extension consumes accepted `@pi/presence` V2 state, terminal, and withdraw events. Shared producer lifecycle, receipts, generation/sequence fences, withdrawal, and terminal encoding remain defined by the pinned [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20261013-1/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20261013-1/docs/lifecycle.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20261013-1/fixtures/normative.json).

## Pi tool-result and continuation semantics

Pi `0.99.2` emits nested `tool_result` events from `ctx.executeTool()` with `parentToolCallId`; nested calls are not transcript tool results. Successful nested Todo results use the same provenance-fenced, bounded aggregate-only snapshot validation as top-level results. An `isError: true` Todo result never replaces progress. Error text in an otherwise successful Todo snapshot remains structurally validated but semantically ignored.

Only a top-level tool result (`parentToolCallId` absent or an own data value of `undefined`) can set the turn failure fallback. Nested errors may be handled by their caller, so they neither mark the parent failed nor emit their own failure alert. A failed parent result still sets the fallback. Malformed/accessor-backed parent markers are not promoted to top-level failures. Explicit final assistant stop reasons retain precedence over this fallback, including retry recovery. No parent IDs, nested arguments, or error text are retained or projected.

`agent_end` derives the candidate terminal but does not settle the parent turn or erase its long-running working-time budget: automatic continuations preserve it. Only `agent_settled` emits the terminal pair and clears the budget; replacement and shutdown also clear it. In Pi `1.1.0`, `agent_settled.aborted: true` overrides the `agent_end` candidate with the existing `cancelled` state and V2 `cancelled` outcome, including cancellation during tools, retry backoff, or compaction recovery. Cancellation remains quiet (no completion/failure notification). Detached startup retains only this derived boolean alongside the ordered lifecycle edges, under the same manager/ID/epoch fence. An absent `aborted` field on older hosts or `false` preserves the candidate derived from stop reasons and top-level tool failures; successful retry recovery is unchanged.

## Pi native program status coexistence

Pi `1.1.0` separately reports [Program Status Protocol (OSC 7501)](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/terminal-setup.md#program-status) state when the terminal confirms support. Pi owns detection and the `PI_PROGRAM_STATUS=1|0` override. Native reports can contain the session name, dialog title, or first error line; these are not inputs to this extension's privacy-bounded Herdr projection. This extension neither emits duplicate OSC reports nor sends terminal commands, and never forwards native report text. Native reporting does not replace the Herdr Unix-socket protocol, shared V2 events, or standalone/companion authority boundaries.

## Pane projection

Every ordinary pane metadata render has exactly these ten keys:

- `summary`
- `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`
- `v2_terminals`, `v2_terminal_overflow`
- `tokens`, `cost`, `context`

사용할 수 없는 값은 `summary`를 제외하고 `null`이다. `summary`는 기존의 제한된 안전 파생 문법을 유지하며, title은 정확히 `Pi · ${summary}`, `display_agent`는 `Pi`이다. `state_labels`의 키는 기존 `idle`, `working`, `blocked`, `unknown`을 유지하고 표시 문자열만 각각 `Pi · ○ Idle`, `Pi · ▶ Running`, `Pi · ! Needs attention`, `Pi · ? Unknown`으로 고정한다. 임의 컨텍스트는 이 필드에 들어가지 않는다.

### 사람용 표시와 프로토콜 경계

사람용 문자열은 **대상 → 의미 아이콘과 상태 → 필요한 세부사항** 순서의 짧은 영어를 사용한다. 아이콘만으로 상태를 구분하지 않으며, `pi-tool-display`를 import하거나 renderer·테마·실행 경로를 통합하지 않는다.

| 표시 표면 | 표시와 한계 |
| --- | --- |
| Pane 고정 레이블 | 위 네 가지 문자열. Herdr의 `blocked`는 실패·차단·입력 대기를 모두 포함할 수 있으므로 고정 레이블은 `Needs attention`으로 유지한다. |
| Standalone 상태 메시지 | `Pi · ▶ Running`, `Pi · ◷ Waiting`, `Pi · ? Waiting for input`, `Pi · ! Blocked`, `Pi · ✗ Failed`, `Pi · ○ Idle`, `Pi · ? Unknown`. 입력 대기가 실패보다 우선한다. 부모가 활동 중이거나 다른 실행 중 상태가 있으면 단순 대기 이벤트만으로 전체를 대기로 표시하지 않는다. |
| Subagent 상태 메시지 | 부모가 활동 중이 아닐 때 `Subagents · ▶ Running`, `Subagents · ■ Stopping`, `Subagents · ◷ Queued`. 과거 실패 카운트만으로 현재 실패를 추정하지 않는다. |
| 정책 허용 알림 | 입력 `Pi · ? Waiting for input`, 차단 `Pi · ! Blocked`, 실패 `Pi · ✗ Failed`, 완료 `Pi · ✓ Completed`, 장기 실행 `Pi · ▶ Still running`. 본문은 정적 텍스트이며 정책·소리·중복 억제·전송 예약은 변경하지 않는다. |
| Title, pane `summary`, workspace `main_summary` | 기존 title 식과 canonical 문법을 유지한다. `running N`, `stopping N`, `queued N`, 진행률과 `input N`, `terminal completed/failed/cancelled`가 필수 세부사항을 전달한다. 토큰에 새 아이콘이나 키를 넣지 않는다. |
| Companion 입력 lease | managed integration으로 전달하는 `herdr:blocked`와 기존 `Pi needs your input` lease 레이블은 그대로다. managed 상태 메시지를 이 확장이 직접 바꾸지 않는다. |
| 도움말·진단 | 별도 명령·도움말·진단 UI가 없다. 관찰 실패는 계속 output-only로 처리한다. |

완료·실패·취소는 알려진 terminal outcome을 기존 summary로 구분하며, `idle`을 완료로 바꾸지 않는다. 취소는 여전히 알림 없이 표시만 한다. Title과 workspace summary는 wire 계약이므로 사람용 문자열과 달리 번역·아이콘 치환하지 않는다. 자동 검증은 가짜 Unix socket을 사용하며 실제 Herdr의 글꼴·아이콘 폭·화면 배치는 별도 검증 범위다.

The summary retains `working` or `idle` and may append the latest accepted terminal arrival as `terminal completed`, `terminal cancelled`, or `terminal failed`. Within the 80-byte/code-point budget, the state is always retained; space for the applicable V2 `input N` or terminal suffix is reserved first; then `progress`, positive `running`, positive `stopping`, and positive `queued` segments are attempted in that order before the reserved suffix is appended. Zero counts and lower-priority segments that do not fit are omitted. Blocked, input, and failure state take precedence over the transient terminal segment. A native-only TUI prompt uses the fixed `summary: "input"` while both V2 input tokens remain `null`. An accepted V2 `interaction`/`waiting` DTO remains input-waiting at the shared protocol's inclusive `pending: 0` boundary, so its projection is `ask_user:0` and `input 0`; malformed raw counts remain rejected by the shared parser. `v2_terminals` is independently canonically encoded and can have a different sort order. Terminal records, the terminal summary segment, and both terminal tokens clear together after `PI_HERDR_PRESENCE_FINAL_CLEAR_MS`.

## Mode-specific envelopes

| Mode | Ordinary metadata owner | Startup/teardown cleanup | Lifecycle authority |
| --- | --- | --- | --- |
| Standalone | `source: "herdr:pi"`, `applies_to_source: "herdr:pi"`, `agent: "pi"` | Current presentation + ten tokens, then separate 12-key legacy token cleanup | Reports and may clear `herdr:pi` session/state authority |
| Companion | `source: "herdr:pi-presence"`, `applies_to_source: "herdr:pi"` | Its current presentation + ten tokens only | Never reports or clears lifecycle/session authority directly |

Companion mode bridges aggregate native TUI prompt-or-accepted V2 `ask_user` waiting state to the managed integration through balanced in-process `herdr:blocked` events. It emits one fixed-label acquire on the absent-to-present transition and one release on the present-to-absent transition, replacement, or shutdown. The managed `herdr:pi` integration alone converts that lease into socket lifecycle reports; no question, option, or answer content is included.

## 네이티브 입력 집계

네이티브 `ui_prompt_start`는 프롬프트 본문·선택지·응답을 보관하거나 전송하지 않는다. 비동기 시작 중에는 세션 ID와 epoch에 묶인 불리언 대기 상태만 보관하고, 정확히 같은 TUI 세션이 활성화될 때만 채택한다. 교체·종료·비-TUI 또는 오래된 이벤트는 폐기한다. 네이티브 프롬프트와 수락된 V2 `ask_user`는 도착 순서와 관계없이 하나의 입력 수명주기로 집계된다. 알림 정책이 허용하면 이 수명주기는 고정된 `Pi · ? Waiting for input` 제목과 본문으로 알림을 정확히 한 번만 낸다.

Both ordinary envelopes include `pane_id`, a process-coordinated `seq`, title, fixed display fields, and the exact ten-token map.

수락된 V2 `interaction`/`waiting` DTO의 `pending`은 `0`도 유효한 경계값입니다. Herdr는 이를 입력 대기 수명주기로 유지하며 `ask_user:0`과 `input 0`만 투영합니다. 음수·소수·추가 필드 등 원시 비정상 입력은 shared parser에서 계속 거부됩니다. Standalone startup sends the current metadata clear and separate legacy-token clear before session/state authority and ordinary metadata. Companion sends only its own current metadata clear before its ordinary metadata.

On teardown, after any standalone session-report attempt—including a lost or malformed response—the client first makes one priority, non-retried `pane.clear_agent_authority` attempt, then clears its current and legacy projection while the original lifecycle deadline allows. Companion clears only its own current presentation/token projection. Cleanup is best-effort and non-retried. The extension emits neither focus/control operations nor arbitrary text.

## Workspace lease envelope

Workspace metadata is separate from the ten pane tokens. An eligible attempt sends only:

```text
workspace_id, source: "herdr:pi-presence", seq, ttl_ms: 30000,
tokens: { main_summary }
```

It accepts only the exact `{ type: "ok" }` response. `main_summary` must use the same canonical bounded summary grammar as pane `summary`; no presentation fields or additional tokens are accepted. Each attempt first validates a `v0.9.5` protocol-`22`, workspace-scoped `pane.list` response. A row has an exact allowlist of fields that Herdr `v0.9.5` serializes: required `pane_id`, `terminal_id`, `workspace_id`, `tab_id`, `focused`, `agent_status`, and `revision`; optional `cwd`, `foreground_cwd`, `restore_error`, `label`, `agent`, `title`, `terminal_title`, `terminal_title_stripped`, `display_agent`, `state_labels`, `tokens`, `agent_session`, and `scroll`. Unknown fields are rejected, even if another schema might allow additional properties. The validator admits schema-valid omissions and nullable fields, including an absent or `null` `agent`, only after bounded validation. The snapshot is locally bounded to `128` rows, unique pane IDs, bounded strings and nested values, and at most `32` entries in each accepted `state_labels` or `tokens` map. A malformed, oversized, or out-of-scope snapshot fails closed and produces no workspace write.

`v0.9.3`–`v0.9.5`의 bundled API schema는 동일합니다([검증 범위](development.md#herdr-095-호환성-확인)). The [v0.9.5 upstream PaneInfo schema](https://github.com/herdrdev/herdr/blob/v0.9.5/src/api/schema/panes.rs) declares `restore_error` as optional nullable text. Locally it may be omitted or `null`, or be plain text (including empty) of at most 512 UTF-8 bytes with no control or bidi characters. It is validated only as ignored text, never copied into metadata or interpreted as Pi failure. `resume_argv` is not emitted; it requires a separate design/PR.

Validation is an admission check, not extra selection logic. Once admitted, sole-Pi eligibility uses only `agent` and `pane_id`: exactly one row with `agent: "pi"` must be present, and that row's `pane_id` must equal this runtime's pane ID. An absent or `null` `agent` is admitted but is not Pi. The outgoing workspace lease remains exactly the envelope shown above; optional `PaneInfo` fields are never copied into it.

The next attempt occurs 10 seconds after the prior attempt completes, not on every pane update. A list and write each have one five-second, no-retry budget. Workspace tokens are not source-cleared: ineligibility, error, replacement, and teardown let the 30-second TTL expire instead.

## Transport rules

Each request uses a fresh Unix-socket connection and receives one newline-delimited response. Requests and responses are schema-validated and bounded to 16 KiB. The normal lifecycle path has at most two bounded attempts; workspace writes and notifications have one. Lifecycle requests retain their caller's original absolute deadline through queueing and socket dispatch, so expired work is rejected before enqueue and again before drain. Actionable notification queue residency is bounded to `clamp(timeout_ms × (max_queue + 1), 1 s, 30 s)` and stays active through fingerprinting, connection, and final pre-write validation. A fresh configured socket-attempt timeout begins at dequeue, while `dispatched` is emitted only after `socket.write()` accepts the complete line without a synchronous throw. Queue disposition is exactly once after admission: `dispatched`, or released-before-dispatch as `timed_out`, `cancelled`, `pre_dispatch_failure`, `coalesced`, `priority_cleanup`, `actionable_displacement`, or `closed`. `pre_dispatch_failure` covers fingerprint, validation, connection, and other failures before the physical write; every released disposition rolls back its dedupe/rate reservation. Only outcomes after a successful physical `socket.write()` are committed, delivery-unknown, and never retried or rolled back. An active client suppresses only wire-equivalent, previously acknowledged ordinary `pane.report_agent` and `pane.report_metadata` projections (request IDs and `seq` are excluded) for five seconds; the next identical projection repairs a restarted or externally changed Herdr pane. Failed, malformed, stale, notification, session, workspace, and cleanup requests remain live. The bounded queue coalesces keyed work only within its protected, actionable, or replaceable lane. An actionable request can evict one queued replaceable item, but never protected/actionable work or active work; protected and actionable requests are preserved. Only priority cleanup bypasses ordinary admission and flushes queued work. Replacement or teardown lifecycle fences actively cancel outstanding notifications as well as the keyed replaceable workspace list and summary observers. Validation, serialization, and transport errors remain output-only.
