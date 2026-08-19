# Configuration and operation

This is the authoritative configuration reference. For module flow see [architecture](architecture.md); for exact Herdr envelopes see [event contract](event-contract.md); for ownership and privacy see [feature ownership](feature-ownership.md).

## Activation prerequisites

Output can start only for a TUI `session_start` on Linux or macOS when all of the following hold:

- `HERDR_ENV=1`;
- `HERDR_SOCKET_PATH` is an absolute nonempty Unix-socket path;
- `HERDR_WORKSPACE_ID` and `HERDR_PANE_ID` are nonempty, safe opaque IDs; and
- the managed-marker probe selects an active mode.

The extension never derives a workspace ID from a pane ID. Socket validation requires an owner-only socket and safe non-replaceable ancestor directories. Invalid identity, socket, probe, protocol, or transport conditions are observer-only and disable or drop output rather than failing Pi lifecycle work.

## Settings

All values are read from the environment. Booleans are case-insensitive after surrounding whitespace is removed: `1`, `true`, `yes`, and `on` mean true; `0`, `false`, `no`, and `off` mean false. An unset, empty, malformed, or out-of-range setting falls back to the default. Integer values must be decimal digits only (no sign, decimal point, or exponent). Enum values are case-insensitive after trimming; unrecognized values fall back to the default.

| Variable | Default | Accepted values | Effect |
| --- | ---: | --- | --- |
| `PI_HERDR_PRESENCE_ENABLED` | `true` | Boolean | Global observer switch; false disables all active modes. |
| `PI_HERDR_PRESENCE_MODE` | `auto` | `auto`, `standalone`, `companion`, `disabled` | Can restrict, never upgrade, the proven marker result. |
| `PI_HERDR_PRESENCE_SOLE_REPORTER` | `false` | Boolean | Deprecated compatibility acknowledgement. It does not gate automatic standalone activation. |
| `PI_HERDR_PRESENCE_TIMEOUT_MS` | `1000` | Integer `100`–`30000` | Normal request/response budget, split across at most two lifecycle attempts. |
| `PI_HERDR_PRESENCE_MAX_QUEUE` | `16` | Integer `1`–`128` | Bound for pending latest-write-wins socket entries. |
| `PI_HERDR_PRESENCE_METADATA` | `true` | Boolean | Enables ordinary live pane metadata and the workspace lease. Owned startup/teardown cleanup still runs. |
| `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` | `1500` | Integer `0`–`60000` | Retention period before terminal metadata is quietly refreshed without its terminal batch. |
| `PI_HERDR_PRESENCE_MAX_LABEL_CHARS` | `96` | Integer `16`–`256` | Bound for safe pane-state messages. |
| `PI_HERDR_PRESENCE_NOTIFICATIONS` | `true` | Boolean | Global static-notification kill switch. |
| `PI_HERDR_PRESENCE_NOTIFY_POLICY` | `errors` | `errors`, `background`, `settled`, `all`, `disabled` | Selects eligible notification classes below. |
| `PI_HERDR_PRESENCE_LONG_RUNNING_MS` | `30000` | Integer `1000`–`300000` | Local long-running threshold used by eligible policies. |

`PI_HERDR_PRESENCE_METADATA=false` does not remove mode ownership or cleanup. It prevents ordinary `pane.report_metadata` projection and prevents all `workspace.report_metadata` `main_summary` attempts; the active client's startup clear still removes its owned current projection, and standalone additionally clears its owned legacy projection. Session/state reports remain standalone-only.

## Managed marker and mode selection

The extension non-executingly inspects `extensions/herdr-agent-state.ts` under Pi's agent directory. It accepts a managed file only when it is a stable regular file no larger than 64 KiB and contains the exact marker `HERDR_INTEGRATION_ID=pi`; the bounded probe has a 250 ms deadline. Symlinks, unsafe/non-regular/oversized/mutating files, read errors, malformed configuration, and timeouts are `unknown` and fail closed.

`PI_CODING_AGENT_DIR` follows Pi's lexical behavior as closely as this later probe can safely mirror:

- unset or empty uses `$HOME/.pi/agent` (or the OS home when `HOME` is unset or empty);
- exact `~` expands to the home directory and `~/...` expands below it;
- `HOME` is validated as a nonempty absolute, normalized path before **any** `PI_CODING_AGENT_DIR` value is accepted, including an otherwise absolute override;
- a nonempty absolute, normalized `PI_CODING_AGENT_DIR` is then accepted verbatim;
- whitespace-padded, control/bidi-containing, relative, or lexically ambiguous values are `unknown` rather than normalized into a different location.

| Probe result | `auto` result | Explicit `standalone` | Explicit `companion` |
| --- | --- | --- | --- |
| Exact managed marker present | companion | disabled | companion |
| Exact initial `ENOENT` | standalone | standalone | disabled |
| Unknown/ambiguous | disabled | disabled | disabled |

`disabled` mode or `PI_HERDR_PRESENCE_ENABLED=false` always disables output. A file probe cannot prove that another process did or did not load an integration, so it is not cross-process authority proof.

## Workspace `main_summary`

When metadata is enabled, the extension can lease one workspace token, `main_summary`, under `herdr:pi-presence`. It uses the existing bounded pane `summary` grammar only. Before each initial or heartbeat write it performs a read-only, workspace-scoped `pane.list`, accepts a bounded schema-faithful result, and writes only when exactly one reported/detected `agent: "pi"` pane exists and it is this opaque pane ID. `PaneInfo.agent` may be absent or `null`; neither counts as Pi.

The write has `ttl_ms: 30000`. The next attempt is scheduled 10 seconds after the previous attempt completes; the list and write each get one five-second, no-retry budget. A pane metadata update only changes the value used by a later heartbeat—it does not synchronously update workspace metadata. Eligibility is a separate read and write, so it is non-atomic and not authority proof. Errors, malformed lists, zero/multiple/foreign Pi panes, replacement, and teardown never clear workspace metadata; the lease expires.

To render the leased workspace summary and pane summary in Herdr's sidebar, configure Herdr (not this extension):

```toml
[ui.sidebar.spaces]
rows = [["workspace", "$main_summary"]]

[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "tab"], ["agent", "$summary"]]
```

When the workspace row already shows `$main_summary`, leaving only `["agent"]` for Pi avoids duplicate text.

## Notifications

Notifications always use fixed local text, are bounded/deduplicated, and are not retried. Retained activation replay is quiet. `PI_HERDR_PRESENCE_NOTIFICATIONS=false` and policy `disabled` send none. In every enabled policy, live errors and new attention edges remain eligible.

| Policy | Additionally eligible |
| --- | --- |
| `errors` | Nothing: live terminal failures and new `blocked`, `input_required`, or `failure` attention only. |
| `background` | External success/info and local or external long-running notices. |
| `settled` | Local successful settlement only. |
| `all` | Local and external success/info plus long-running notices. |
| `disabled` | Nothing. |

Completion and cancellation remain quiet under the default `errors` policy.
