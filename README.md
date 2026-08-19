# pi-herdr-presence

`pi-herdr-presence` is a Pi TUI extension that reports local presence to Herdr through its supplied Unix socket. It supports Linux and macOS only; it never runs a CLI, shell, child process, poller, or subscription.

## Install

```bash
pi install git:github.com/spi-ca/pi-herdr-presence
# project-local
pi install -l git:github.com/spi-ca/pi-herdr-presence
```

Use an absolute checkout path for local development and run `/reload` after changing it.

## Herdr behavior

The extension runs only with `HERDR_ENV=1`, an absolute `HERDR_SOCKET_PATH`, a nonempty `HERDR_PANE_ID`, and a TUI `session_start`. Each request uses a new socket connection; observer, validation, serialization, and socket failures never fail Pi lifecycle work.

Mode selection is fail-closed: an exact managed `herdr-agent-state.ts` selects **companion**, exact `ENOENT` selects **standalone**, and unreadable, malformed, unsafe, or timed-out probes select **disabled**. `PI_HERDR_PRESENCE_MODE` can restrict but cannot override that result. File probing cannot prove whether a managed integration was already loaded in another process, so it is not cross-process authority proof.

Standalone reports session, pane state, metadata, policy-gated notifications, and teardown authority cleanup as `source: "herdr:pi"`. It sends current presentation cleanup and legacy-token cleanup as separate envelopes. Companion coexists with the managed reporter using bounded token metadata under `source: "herdr:pi-presence"`, applied to `herdr:pi`, and may emit policy-gated static notifications. It never emits session/state authority, presentation, legacy cleanup, authority clear, focus/control, or arbitrary text.

Standalone title is exactly `Pi · ${summary}`, derived only from the bounded safe `summary` token; display agent and state labels remain fixed. Companion emits no title. No cwd, prompt, session name/path, task or subagent argument, output, or raw error is read or projected.

Each metadata report uses this exact ten-token map:

`summary`, `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`, `v2_terminals`, `v2_terminal_overflow`, `tokens`, `cost`, `context`.

`summary` is a bounded safe-derived state/progress/count projection. For non-blocked, non-input work it retains the semantic `working` or `idle` segment and appends `terminal completed`, `terminal cancelled`, or `terminal failed` from the latest accepted terminal arrival. Blocked, input, and failure state suppress that transient segment. The terminal token remains the shared canonical encoding, which has a different sort order. Terminal state expires with the retained terminal records after `PI_HERDR_PRESENCE_FINAL_CLEAR_MS`.

To show `$summary` in Herdr's sidebar, apply the [operator configuration](docs/configuration.md#showing-pi-summary-in-herdr); default Herdr rows may not render custom metadata tokens.

## Notifications

Notifications default to the `errors` policy. Only live accepted terminal failures and new `blocked`, `input_required`, or `failure` attention edges can notify under that policy; retained replay remains quiet. Alerts have fixed text, are bounded and deduplicated, and are never retried.

## Documentation

- [Configuration, mode selection, and notifications](docs/configuration.md)
- [Metadata and cleanup envelope contract](docs/event-contract.md)
- [Lifecycle, privacy, and ownership](docs/feature-ownership.md)
- [Shared producer integration](docs/pi-subagent-integration.md)
- [Development and verification](docs/development.md)

```bash
bun install --frozen-lockfile
bun run ci
bun pm pack --dry-run
```
