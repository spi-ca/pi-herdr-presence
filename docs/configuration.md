# Herdr socket and authority

The extension activates only with `HERDR_ENV=1`, an absolute nonempty `HERDR_SOCKET_PATH`, nonempty opaque `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID` values, and a TUI `session_start`. It never infers a workspace from pane-ID syntax. It uses one Unix-socket connection per request; socket and validation failures are observer-only.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_HERDR_PRESENCE_ENABLED` | `true` | Enable the observer |
| `PI_HERDR_PRESENCE_MODE` | `auto` | `auto`, `standalone`, `companion`, or `disabled`; explicit modes can only restrict a proven result |
| `PI_HERDR_PRESENCE_SOLE_REPORTER` | `false` | Deprecated compatibility setting; it does not gate automatic standalone activation |
| `PI_HERDR_PRESENCE_TIMEOUT_MS` | `1000` | Bounded connection-response budget |
| `PI_HERDR_PRESENCE_MAX_QUEUE` | `16` | Latest-write-wins pending entries |
| `PI_HERDR_PRESENCE_METADATA` | `true` | Send ordinary ten-token metadata (cleanup still runs) |
| `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` | `1500` | Terminal retention before a quiet metadata refresh |
| `PI_HERDR_PRESENCE_MAX_LABEL_CHARS` | `96` | Safe pane-state message bound |
| `PI_HERDR_PRESENCE_NOTIFICATIONS` | `true` | Global static-toast kill switch |
| `PI_HERDR_PRESENCE_NOTIFY_POLICY` | `errors` | `errors`, `background`, `settled`, `all`, or `disabled` |
| `PI_HERDR_PRESENCE_LONG_RUNNING_MS` | `30000` | Long-running threshold for eligible advanced policies |

## Managed authority

A non-executing probe of `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` selects the mode: exact managed-file presence is **companion**, exact `ENOENT` is **standalone**, and unreadable, malformed, ambiguous, unsafe, or timed-out probes are **disabled**. File probing cannot prove whether an integration has already been loaded in a different process; it is therefore not cross-process authority proof.

Standalone owns `herdr:pi` session and pane authority. Companion uses `herdr:pi-presence`, applied to `herdr:pi`, to project the same fixed presentation and bounded exact ten-token metadata map, and may emit policy-gated static notifications. It never claims, reports, or clears lifecycle or session authority; it clears only its own presentation/token metadata, never legacy metadata, authority, focus/control, or arbitrary text.

## Workspace main summary

In addition to the fixed pane projection, an eligible runtime leases the single `main_summary` workspace token through `workspace.report_metadata` with `source: "herdr:pi-presence"` and a fixed 30-second TTL. It attempts a heartbeat 10 seconds after each completed attempt. Each list/read and write has one fixed 5-second budget with no retry, keeping read + write + cadence below the TTL; repeated failures can still let the lease expire. Its value is only the existing canonical bounded `summary` grammar. Before every write it performs a read-only `pane.list` scoped by `workspace_id`, accepts only a bounded schema-faithful result, and publishes only when exactly one **reported/detected** `agent: "pi"` pane exists in that workspace and it is this pane. Herdr 0.8.0 `PaneInfo.agent` is optional and nullable, so absent, `null`, and safe non-Pi agent strings are valid non-Pi panes and do not affect that count. PaneInfo has no authority-source binding, and the list/write topology is non-atomic, so this cannot prove reporter authority or exclude a topology change after the list snapshot. Errors, malformed/oversized lists, zero/multiple/foreign Pi panes, replacement, and teardown send no workspace clear; the lease naturally expires.

## Showing Pi summary in Herdr

This is Herdr operator configuration, not extension or Herdr code. Herdr's default sidebar rows may not display custom metadata tokens, so configure both the workspace lease token and Pi's pane token explicitly:

```toml
[ui.sidebar.spaces]
rows = [["workspace", "$main_summary"]]

[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "tab"], ["agent", "$summary"]]
```

When the workspace row already shows `$main_summary`, optionally remove `$summary` from Pi's agent row (leave `["agent"]`) to avoid displaying the same summary twice.

## Notifications

The default `errors` policy sends fixed, policy-gated notifications only for live accepted terminal failures and new `blocked`, `input_required`, or `failure` attention edges. Activation replay and ordinary completion stay quiet. `background` and `all` also permit the local long-running timer; `disabled` or `PI_HERDR_PRESENCE_NOTIFICATIONS=false` sends none.

In both modes, the title is exactly `Pi · ${summary}`, derived only from the bounded safe `summary` token; `display_agent` is fixed to `Pi` and `state_labels` are fixed. The extension does not read or project cwd, prompts, session names or paths, task/subagent arguments, output, or raw errors.
