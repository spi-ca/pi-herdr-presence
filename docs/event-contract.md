# Ten-token metadata projection

This extension consumes accepted `@pi/presence` V2 state, terminal, and withdraw events. Shared protocol and terminal encoding remain defined by the pinned [protocol API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).

Every ordinary render has exactly these keys:

- `summary`
- `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`
- `v2_terminals`, `v2_terminal_overflow`
- `tokens`, `cost`, `context`

Unavailable values are `null` except `summary`, which is always a bounded safe-derived grammar. It retains semantic `working` or `idle` and, unless blocked/input/failure takes precedence, appends the latest accepted terminal arrival as `terminal completed`, `terminal cancelled`, or `terminal failed`. When that closed segment needs space, lower-priority progress/count segments are omitted rather than truncating the grammar. `v2_terminals` remains separately encoded by the shared canonical encoder; its canonical sort order is not used to choose the summary outcome. Terminal records, their summary segment, and both terminal tokens clear together after the configured retention period.

## Standalone envelopes and cleanup

Standalone uses `source: "herdr:pi"`. Its ordinary metadata envelope includes `pane_id`, `source`, `applies_to_source`, `agent`, `seq`, `title: "Pi · ${summary}"` derived only from the bounded safe `summary` token, fixed `display_agent: "Pi"`/state labels, and the ten-token map. No context or arbitrary text is projected.

Before standalone reports ordinary metadata, it sends two separate bounded, non-retried cleanup envelopes: a current projection clear with presentation-clear flags and all ten tokens `null`, then a legacy-token-only clear with its exact twelve old keys `null`. They remain separate because each is independently owned and bounded. Teardown repeats both and, only if time remains, may send the standalone authority clear.

## Companion envelopes and cleanup

Companion uses `source: "herdr:pi-presence"` and `applies_to_source: "herdr:pi"`. Its ordinary metadata envelope contains `pane_id`, `source`, `applies_to_source`, `seq`, `title: "Pi · ${summary}"` derived only from the bounded safe `summary` token, `display_agent: "Pi"`, fixed `state_labels` (`idle: "Pi is idle"`, `working: "Pi is working"`, `blocked: "Pi needs attention"`, `unknown: "Pi state unknown"`), and the exact ten-token map. Its cleanup envelope contains the same ownership fields and sequence plus presentation-clear flags and all ten tokens `null`.

Companion clears only its own presentation/token metadata and may emit policy-gated static notifications. It never claims, reports, or clears session or lifecycle authority, and never emits legacy cleanup, authority clear, focus/control, or arbitrary text.

Notifications default to `errors`: only live accepted terminal failures and new `blocked`, `input_required`, or `failure` attention edges are eligible. Notifications have fixed text and are never retried.
