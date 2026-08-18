# Nine-token metadata projection

This extension consumes the shared `@pi/presence` V2 stream and translates accepted state, terminal, and withdraw events into Herdr's fixed metadata projection. It does not define, restate, or fork the shared protocol.

The immutable canonical references pinned by this package are:

- [protocol API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md)
- [consumer and producer lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md)
- [canonical terminal encoding fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json)

Herdr receives exactly these keys on every metadata render, with `null` for unavailable values:

- `v2_progress`
- `v2_attention`
- `v2_interaction`
- `v2_subagents`
- `v2_terminals`
- `v2_terminal_overflow`
- `tokens`
- `cost`
- `context`

Non-null values are fixed compact projections only: canonical V2 progress (`completed/total`), attention (`reason:occurrence`), interaction (`ask_user:pending`), and seven-count subagent values; the shared canonical terminal batch plus its canonical overflow integer; and bounded canonical decimal usage values. No arbitrary text is a valid token value. `v2_terminals` and `v2_terminal_overflow` are either both `null` or both populated.

Before restoring session authority or sending any ordinary envelope, startup sends two bounded, non-retried cleanup chunks: current V2 `clear_title`/`clear_display_agent`/`clear_state_labels` flags with all nine tokens set to `null`, then a token-only patch for the exact pre-V2 keys `active`, `completed`, `failed`, `queued`, `cancelled`, `total`, `progress`, `subagents`, `subagent_wait`, `subagent_error`, `subagent_terminal`, and `subagent_terminal_at`, all set to `null`. The chunks contain 9 and 12 tokens respectively (never more than 16), contain no text or paths, and the startup fence cannot follow a fixed presentation report.

`v2_terminals` is always formed by the shared canonical encoder. Because unmodified Herdr accepts at most 80 UTF-8 bytes for this token value, the projection omits oldest retained terminal records until the encoded canonical value fits. It retains the newest records and adds every omission to bounded `v2_terminal_overflow`.

An ordinary metadata envelope contains `pane_id`, `source`, `applies_to_source`, `agent`, `seq`, fixed `title`/`display_agent`/`state_labels`, and `tokens`. The presentation values are only the fixed strings `Pi`, `Pi is idle`, `Pi is working`, `Pi needs attention`, and `Pi state unknown`; no path, prompt, output, error text, producer label, or identifier is allowed. Teardown repeats both cleanup chunks within one deadline. Only when those stages leave time and the client is still open does it make at most one priority, non-retried `pane.clear_agent_authority` attempt. Its strict envelope contains only `pane_id`, `source: "herdr:pi"`, and `seq`; it has no `agent`, metadata, path, or text field. Deadline expiry can prevent this dispatch, so the remote clear is not unconditional exactly-once. Startup and teardown cleanup are independent of the ordinary metadata setting.

Under the default `errors` policy, only live receipt-accepted V2 terminal failures and new `blocked`, `input_required`, or `failure` attention edges can send one bounded static `notification.show`; retained activation replay cannot. Opt-in `background` and `all` policies also allow the local long-running timer's static alert, which is not a V2 edge. See the pinned [protocol API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).
