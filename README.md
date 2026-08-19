# pi-herdr-presence

`pi-herdr-presence` is a Pi TUI extension that reports local presence to Herdr through its supplied Unix socket. It supports Linux and macOS only; it never runs a CLI, shell, child process, or subscription. Its only recurring timer is the bounded workspace-summary lease heartbeat.

## Install

```bash
pi install git:github.com/spi-ca/pi-herdr-presence
# project-local
pi install -l git:github.com/spi-ca/pi-herdr-presence
```

Use an absolute checkout path for local development and run `/reload` after changing it.

## Herdr behavior

The extension runs only with `HERDR_ENV=1`, an absolute `HERDR_SOCKET_PATH`, nonempty opaque `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID` values, and a TUI `session_start`. It never derives a workspace by parsing a pane ID. Each request uses a new socket connection; observer, validation, serialization, and socket failures never fail Pi lifecycle work.

Mode selection is fail-closed: an exact managed `herdr-agent-state.ts` selects **companion**, exact `ENOENT` selects **standalone**, and unreadable, malformed, unsafe, or timed-out probes select **disabled**. `PI_HERDR_PRESENCE_MODE` can restrict but cannot override that result. File probing cannot prove whether a managed integration was already loaded in another process, so it is not cross-process authority proof.

Standalone reports session, pane state, metadata, policy-gated notifications, and teardown authority cleanup as `source: "herdr:pi"`. It clears its current presentation/token projection and legacy-token projection in separate envelopes. Companion coexists with the managed reporter under `source: "herdr:pi-presence"`, applied to `herdr:pi`: it projects the same fixed presentation and exact ten-token metadata map, and may emit policy-gated static notifications.

In both modes, the title is exactly `Pi · ${summary}`, derived only from the bounded safe `summary` token; `display_agent` is fixed to `Pi` and `state_labels` are fixed. Companion never claims, reports, or clears lifecycle or session authority; it clears only its own presentation/token metadata and never clears legacy metadata, authority, focus/control, or arbitrary text. No cwd, prompt, session name/path, task or subagent argument, output, or raw error is read or projected.

Each pane metadata report uses this exact ten-token map:

`summary`, `v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`, `v2_terminals`, `v2_terminal_overflow`, `tokens`, `cost`, `context`.

Independently, the extension may lease one workspace token, `main_summary`, from `herdr:pi-presence`, with a 30-second TTL. It attempts a refresh 10 seconds after each completed attempt; each `pane.list` read and `workspace.report_metadata` write gets one fixed 5-second budget (no retry), so a read + write + cadence remains below the TTL. Repeated failures can still let the lease expire. Before every initial or heartbeat write it issues a bounded workspace-scoped `pane.list`; it publishes only when exactly one **reported/detected** `agent: "pi"` pane is present and that pane is its own opaque pane ID. Herdr 0.8.0 `PaneInfo.agent` is optional and nullable, but its records have no authority-source binding, so this is not proof of reporter authority. The list/write topology is unavoidably non-atomic: another pane can change between eligibility read and write. The lease expires instead of being cleared, so multiple Pi panes, malformed responses, errors, replacement, and teardown never destructively alter workspace metadata.

`summary` is a bounded safe-derived state/progress/count projection. For non-blocked, non-input work it retains the semantic `working` or `idle` segment and appends `terminal completed`, `terminal cancelled`, or `terminal failed` from the latest accepted terminal arrival. Blocked, input, and failure state suppress that transient segment. The terminal token remains the shared canonical encoding, which has a different sort order. Terminal state expires with the retained terminal records after `PI_HERDR_PRESENCE_FINAL_CLEAR_MS`.

To show the leased workspace summary and Pi pane summary in Herdr's sidebar, apply this operator configuration; default rows may not render custom metadata tokens:

```toml
[ui.sidebar.spaces]
rows = [["workspace", "$main_summary"]]

[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "tab"], ["agent", "$summary"]]
```

When `$main_summary` is visible in the workspace row, optionally remove `$summary` from Pi's agent row (leave `["agent"]`) to avoid duplication. See the full [operator configuration](docs/configuration.md#showing-pi-summary-in-herdr).

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
