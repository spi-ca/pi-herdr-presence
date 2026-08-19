# Herdr socket and authority

The extension activates only with `HERDR_ENV=1`, an absolute nonempty `HERDR_SOCKET_PATH`, a nonempty `HERDR_PANE_ID`, and a TUI `session_start`. It uses one Unix-socket connection per request; socket and validation failures are observer-only.

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

Standalone owns `herdr:pi` session and pane authority. Companion owns only bounded token metadata under `herdr:pi-presence`, applied to `herdr:pi`, and may emit policy-gated static notifications. It never emits session/state authority, presentation, legacy cleanup, authority clear, focus/control, or arbitrary text.

## Showing Pi summary in Herdr

This is Herdr operator configuration, not extension or Herdr code. Herdr's default sidebar rows may not display custom metadata tokens, so configure Pi's rows explicitly to render the extension's `$summary` token:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "tab"], ["agent", "$summary"]]
```

## Notifications

The default `errors` policy sends fixed, policy-gated notifications only for live accepted terminal failures and new `blocked`, `input_required`, or `failure` attention edges. Activation replay and ordinary completion stay quiet. `background` and `all` also permit the local long-running timer; `disabled` or `PI_HERDR_PRESENCE_NOTIFICATIONS=false` sends none.

Standalone title is exactly `Pi · ${summary}`, derived only from the bounded safe `summary` token; display agent and state labels remain fixed. Companion emits no title. The extension does not read or project cwd, prompts, session names or paths, task/subagent arguments, output, or raw errors.
