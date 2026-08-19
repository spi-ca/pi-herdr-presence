# pi-herdr-presence

`pi-herdr-presence` is a Bun Pi extension reporting TUI-only local presence to Herdr through its supplied socket. Use `bun@1.3.14` and run `bun run ci` before handoff.

Core invariants: only `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, and `HERDR_PANE_ID`; no process/CLI/shell execution, polling, or subscriptions; request-per-connection transport; strict target/socket validation; output-only best-effort failures. Exact managed `herdr-agent-state.ts` presence selects companion coexistence: it owns only bounded `herdr:pi-presence` token metadata applied to `herdr:pi` and may emit policy-gated static notifications. It never emits session/state authority, presentation, legacy cleanup, authority clear, focus/control, or arbitrary text.

See `docs/development.md`, `docs/configuration.md`, and `docs/event-contract.md`.
