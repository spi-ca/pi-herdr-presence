# pi-herdr-presence

`pi-herdr-presence` is a Pi TUI extension that reports bounded local presence to Herdr over its supplied Unix socket. It supports Linux and macOS only. It never runs a CLI, shell, child process, or Herdr subscription/stream; it does subscribe to Pi lifecycle and shared V2 events. Its sole recurring timer is the bounded workspace-summary lease.

## Install

```bash
pi install git:github.com/spi-ca/pi-herdr-presence
# project-local
pi install -l git:github.com/spi-ca/pi-herdr-presence
```

Use an absolute checkout path for local development and run `/reload` after changing it.

## At a glance

The extension starts only for a valid Herdr TUI identity (`HERDR_ENV=1`, absolute `HERDR_SOCKET_PATH`, opaque `HERDR_WORKSPACE_ID`, and opaque `HERDR_PANE_ID`) and an active managed-marker result. It uses one validated Unix-socket connection per request; all observer failures are output-only.

- **Standalone** (exact managed-marker absence) owns `herdr:pi` session/lifecycle authority and its fixed pane presentation/tokens.
- **Companion** (exact managed-marker presence) owns only `herdr:pi-presence` presentation/tokens applied to `herdr:pi`; it delegates aggregate accepted `ask_user` waiting state through one balanced in-process `herdr:blocked` lease while the managed integration retains sole session/lifecycle authority.
- **Disabled** is fail-closed for an ambiguous marker or restrictive configuration.

Pane metadata has exactly ten bounded tokens, including `summary`; the title is `Pi · ${summary}` and display text is fixed. An eligible runtime may lease the same bounded summary as workspace `main_summary` with a 30-second TTL. Workspace updates are eventual at the next completion-relative heartbeat, not synchronous with every pane update, and workspace metadata is never cleared—leases expire.

The Todo adapter structurally traverses Todo `params` and `error` with depth, field, and array-count bounds, but does not byte-bound string leaves. It checks task count and allowed task keys without traversing ignored task-field values; semantically it consumes only task IDs, statuses, and visible/active/completed counts. It never copies, interprets, retains, or projects task text, arguments, or nested values. Stable Todo tool provenance (`path`/`source`/`scope`/`origin`) is retained only as an in-process owner key for the root session and is never projected. Required opaque Herdr pane/workspace IDs, the standalone session ID, and sequence, protocol, and terminal ordinals plus derived counts/tokens are retained or emitted as needed; these are distinct from arbitrary task/subagent text and content identifiers.

## Documentation

Authoritative references:

- [Architecture and module roles](docs/architecture.md)
- [Configuration, marker selection, workspace lease, and notifications](docs/configuration.md)
- [Exact metadata, cleanup, workspace, and transport contract](docs/event-contract.md)
- [Lifecycle authority and privacy ownership](docs/feature-ownership.md)

Supporting references:

- [Shared V2 producer integration](docs/pi-subagent-integration.md)
- [Development, coverage, and manual smoke verification](docs/development.md)

## Common verification

```bash
bun install --frozen-lockfile
bun run ci
bun pm pack --dry-run
```

The real-Herdr smoke is standalone-only, requires a disposable pane, `PI_HERDR_LIVE_SMOKE=disposable-standalone-pane`, `PI_HERDR_PRESENCE_METADATA=true`, `PI_HERDR_PRESENCE_NOTIFICATIONS=false`, and `PI_HERDR_PRESENCE_FINAL_CLEAR_MS>=1000`; it is never automatic CI. See [development](docs/development.md#manual-real-herdr-smoke) before running it.
