# Ten-token metadata projection

This extension consumes accepted `@pi/presence` V2 state, terminal, and withdraw events. Shared protocol and terminal encoding remain defined by the pinned [protocol API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).

Every ordinary render has exactly these keys:

- `summary`
- `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`
- `v2_terminals`, `v2_terminal_overflow`
- `tokens`, `cost`, `context`

Unavailable values are `null` except `summary`, which is always a bounded safe-derived grammar. It retains semantic `working` or `idle` and, unless blocked/input/failure takes precedence, appends the latest accepted terminal arrival as `terminal completed`, `terminal cancelled`, or `terminal failed`. When that closed segment needs space, lower-priority progress/count segments are omitted rather than truncating the grammar. `v2_terminals` remains separately encoded by the shared canonical encoder; its canonical sort order is not used to choose the summary outcome. Terminal records, their summary segment, and both terminal tokens clear together after the configured retention period.

## Workspace main-summary lease

Workspace metadata is intentionally separate from the exact ten pane tokens. After startup, the observer attempts a refresh 10 seconds after each completed attempt while the session remains active. The scoped `pane.list` read and `workspace.report_metadata` write each have one fixed 5-second budget and no retry, so read + write + cadence remains below the 30-second TTL; repeated failures can still let a lease expire. It accepts only a bounded `pane_list` result whose schema-faithful PaneInfo records all identify that workspace and have unique bounded pane IDs. Herdr 0.8.0 `PaneInfo.agent` is optional and nullable, so an absent or `null` agent is valid and only a reported/detected `agent: "pi"` counts; safe non-Pi strings are likewise ignored. It publishes `workspace.report_metadata` only if exactly one record has `agent: "pi"` and its `pane_id` equals this runtime's opaque pane ID.

The report is exactly `workspace_id`, `source: "herdr:pi-presence"`, `seq`, `ttl_ms: 30000`, and `tokens: { main_summary }`, and it accepts only the exact `{ type: "ok" }` response. `main_summary` must pass the same canonical bounded summary grammar as the pane `summary`; arbitrary text, presentation fields, and additional tokens are rejected. PaneInfo does not bind `agent` to an authority source, and the separate list/write topology check is unavoidably non-atomic, so this is not authority proof and a topology change can occur after the list snapshot. Workspace tokens are not source-clearable, so ineligibility, malformed/error responses, replacement, and teardown never clear them; the short TTL is the cleanup mechanism.

## Standalone envelopes and cleanup

Standalone uses `source: "herdr:pi"`. Its ordinary metadata envelope includes `pane_id`, `source`, `applies_to_source`, `agent`, `seq`, `title: "Pi · ${summary}"` derived only from the bounded safe `summary` token, fixed `display_agent: "Pi"`/state labels, and the ten-token map. No context or arbitrary text is projected.

Before standalone reports ordinary metadata, it sends two separate bounded, non-retried cleanup envelopes: a current projection clear with presentation-clear flags and all ten tokens `null`, then a legacy-token-only clear with its exact twelve old keys `null`. They remain separate because each is independently owned and bounded. Teardown repeats both and, only if time remains, may send the standalone authority clear.

## Companion envelopes and cleanup

Companion uses `source: "herdr:pi-presence"` and `applies_to_source: "herdr:pi"`. Its ordinary metadata envelope contains `pane_id`, `source`, `applies_to_source`, `seq`, `title: "Pi · ${summary}"` derived only from the bounded safe `summary` token, `display_agent: "Pi"`, fixed `state_labels` (`idle: "Pi is idle"`, `working: "Pi is working"`, `blocked: "Pi needs attention"`, `unknown: "Pi state unknown"`), and the exact ten-token map. Its cleanup envelope contains the same ownership fields and sequence plus presentation-clear flags and all ten tokens `null`.

Companion clears only its own presentation/token metadata and may emit policy-gated static notifications. It never claims, reports, or clears session or lifecycle authority, and never emits legacy cleanup, authority clear, focus/control, or arbitrary text.

Notifications default to `errors`: only live accepted terminal failures and new `blocked`, `input_required`, or `failure` attention edges are eligible. Notifications have fixed text and are never retried.
