# Shared producer integration

This extension neither imports nor controls `pi-subagent`. It consumes its accepted shared `@pi/presence` V2 state, terminal, and withdraw events like any other producer and projects only the fixed nine Herdr tokens.

Producer ownership, lifecycle, and terminal encoding are defined by the immutable [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json). Task text, prompts, outputs, paths, sockets, and arbitrary IDs are not projected.

A live failed V2 terminal can produce one policy-gated, bounded static `notification.show`; completed and cancelled terminals remain quiet under the default `errors` policy. Retained replay never alerts.
