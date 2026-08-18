# Shared producer integration

This extension neither imports nor controls `pi-subagent`. It consumes accepted shared `@pi/presence` V2 state, terminal, and withdraw events like any other producer and projects only bounded fixed metadata values.

Producer ownership, lifecycle, and terminal encoding are defined by the immutable [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).

No task or subagent argument, prompt, output, path, session name or path, arbitrary ID, or raw error is read or projected. Presentation title remains fixed to `Pi`.

A live failed V2 terminal can produce one policy-gated fixed notification under the default `errors` policy. Completed and cancelled terminals stay notification-quiet by default. The transient terminal summary follows the latest accepted terminal arrival, while `v2_terminals` remains canonical encoded.
