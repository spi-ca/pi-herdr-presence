# Herdr event contract

This is the authoritative Herdr wire-projection contract. [Architecture](architecture.md) describes ordering; [configuration](configuration.md) defines activation and lease eligibility; [feature ownership](feature-ownership.md) defines the authority boundary.

The extension consumes accepted `@pi/presence` V2 state, terminal, and withdraw events. Shared producer lifecycle, receipts, generation/sequence fences, withdrawal, and terminal encoding remain defined by the pinned [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).

## Pane projection

Every ordinary pane metadata render has exactly these ten keys:

- `summary`
- `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`
- `v2_terminals`, `v2_terminal_overflow`
- `tokens`, `cost`, `context`

Unavailable values are `null` except `summary`, which is always a bounded safe-derived grammar. The title is exactly `Pi · ${summary}`. `display_agent` is fixed to `Pi`; `state_labels` are fixed to `Pi is idle`, `Pi is working`, `Pi needs attention`, and `Pi state unknown`. No arbitrary context enters these fields.

The summary retains `working` or `idle` and may append the latest accepted terminal arrival as `terminal completed`, `terminal cancelled`, or `terminal failed`. Blocked, input, and failure state take precedence over that transient terminal segment. `v2_terminals` is independently canonically encoded and can have a different sort order. Terminal records, the terminal summary segment, and both terminal tokens clear together after `PI_HERDR_PRESENCE_FINAL_CLEAR_MS`.

## Mode-specific envelopes

| Mode | Ordinary metadata owner | Startup/teardown cleanup | Lifecycle authority |
| --- | --- | --- | --- |
| Standalone | `source: "herdr:pi"`, `applies_to_source: "herdr:pi"`, `agent: "pi"` | Current presentation + ten tokens, then separate 12-key legacy token cleanup | Reports and may clear `herdr:pi` session/state authority |
| Companion | `source: "herdr:pi-presence"`, `applies_to_source: "herdr:pi"` | Its current presentation + ten tokens only | Never reports or clears lifecycle/session authority directly |

Companion mode bridges aggregate accepted V2 `ask_user` waiting state to the managed integration through balanced in-process `herdr:blocked` events. It emits one fixed-label acquire on the absent-to-present transition and one release on the present-to-absent transition, replacement, or shutdown. The managed `herdr:pi` integration alone converts that lease into socket lifecycle reports; no question, option, or answer content is included.

Both ordinary envelopes include `pane_id`, a process-coordinated `seq`, title, fixed display fields, and the exact ten-token map. Standalone startup sends the current metadata clear and separate legacy-token clear before session/state authority and ordinary metadata. Companion sends only its own current metadata clear before its ordinary metadata.

On teardown, standalone sends the current clear, the legacy clear, and—only while its bounded teardown deadline allows—the `pane.clear_agent_authority` request. Companion clears only its own current presentation/token projection. Cleanup is best-effort and non-retried. The extension emits neither focus/control operations nor arbitrary text.

## Workspace lease envelope

Workspace metadata is separate from the ten pane tokens. An eligible attempt sends only:

```text
workspace_id, source: "herdr:pi-presence", seq, ttl_ms: 30000,
tokens: { main_summary }
```

It accepts only the exact `{ type: "ok" }` response. `main_summary` must use the same canonical bounded summary grammar as pane `summary`; no presentation fields or additional tokens are accepted. Each attempt first validates a bounded `pane.list` response scoped to the same workspace, including unique pane IDs and optional/nullable `agent` fields. It writes only if this runtime is the sole reported `agent: "pi"` pane.

The next attempt occurs 10 seconds after the prior attempt completes, not on every pane update. A list and write each have one five-second, no-retry budget. Workspace tokens are not source-cleared: ineligibility, error, replacement, and teardown let the 30-second TTL expire instead.

## Transport rules

Each request uses a fresh Unix-socket connection and receives one newline-delimited response. Requests and responses are schema-validated and bounded to 16 KiB. The normal lifecycle path has at most two bounded attempts; workspace writes and notifications have one. The bounded queue coalesces latest keyed work, permits priority cleanup, and fences stale output on replacement or teardown; it actively cancels the keyed workspace list and summary requests during replacement or shutdown. Validation, serialization, and transport errors remain output-only.
