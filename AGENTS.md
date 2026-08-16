# pi-cmux-presence

`pi-cmux-presence` is a Bun-based Pi extension that reports local presence to cmux through a Unix socket only. Use the declared `bun@1.3.14` package manager and run `bun run ci` before handoff.

Core invariants: no process/CLI execution, strict workspace/surface target validation, socket-only transport, and best-effort failures that never interrupt Pi work.

See [development notes](docs/development.md), [configuration](docs/configuration.md), and the [event contract](docs/event-contract.md).
