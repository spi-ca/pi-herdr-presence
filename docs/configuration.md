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
| `PI_HERDR_PRESENCE_TIMEOUT_MS` | `1000` | Integer `100`–`30000` | One absolute lifecycle budget, including authority-lane waiting and teardown. Startup work uses the earlier boundary that reserves one quarter (at most 250 ms) for rollback cleanup; any lifecycle request has at most two attempts. |
| `PI_HERDR_PRESENCE_MAX_QUEUE` | `16` | Integer `1`–`128` | Bound for pending latest-write-wins socket entries. Actionable notification residency is derived as `clamp(TIMEOUT_MS × (MAX_QUEUE + 1), 1000, 30000)` ms. |
| `PI_HERDR_PRESENCE_METADATA` | `true` | Boolean | Enables ordinary live pane metadata and the workspace lease. Owned startup/teardown cleanup still runs. |
| `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` | `1500` | Integer `0`–`60000` | Retention period before terminal metadata is quietly refreshed without its terminal batch. |
| `PI_HERDR_PRESENCE_MAX_LABEL_CHARS` | `96` | Integer `16`–`256` | Bound for safe pane-state messages. |
| `PI_HERDR_PRESENCE_NOTIFICATIONS` | `true` | Boolean | Global static-notification kill switch. |
| `PI_HERDR_PRESENCE_NOTIFY_POLICY` | `errors` | `errors`, `background`, `settled`, `all`, `disabled` | Selects eligible notification classes below. |
| `PI_HERDR_PRESENCE_LONG_RUNNING_MS` | `30000` | Integer `1000`–`300000` | Local parent-turn working-time threshold used by eligible policies. Native/V2 input, blocked attention, and failure state pause the budget. |

`PI_HERDR_PRESENCE_METADATA=false` does not remove mode ownership or cleanup. It prevents ordinary `pane.report_metadata` projection and prevents all `workspace.report_metadata` `main_summary` attempts; the active client's startup clear still removes its owned current projection, and standalone additionally clears its owned legacy projection. Session/state reports remain standalone-only.

## Herdr compatibility baseline

The current compatibility target is Herdr application `v0.9.0` with protocol `22`. This is distinct from `HERDR_INTEGRATION_VERSION=8` in Herdr's managed `herdr-agent-state.ts` asset: `8` identifies that managed integration asset and does not identify the Herdr application or socket protocol version.

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

When metadata is enabled, the extension can lease one workspace token, `main_summary`, under `herdr:pi-presence`. It uses the existing bounded pane `summary` grammar only. Before each initial or heartbeat write it performs a read-only, workspace-scoped `pane.list` and validates the Herdr `v0.9.0` `PaneInfo` snapshot within local bounds. The validator admits only its exact recognized-field allowlist: required `pane_id`, `terminal_id`, `workspace_id`, `tab_id`, `focused`, `agent_status`, and `revision`; and optional `cwd`, `foreground_cwd`, `label`, `agent`, `title`, `terminal_title`, `terminal_title_stripped`, `display_agent`, `state_labels`, `tokens`, `agent_session`, and `scroll`. It rejects every unknown field rather than accepting arbitrary schema-valid additional properties, and bounds the list, strings, maps, and nested values before inspecting them. Schema-valid omissions and nullable fields—including an absent or `null` `agent`—are admitted. A malformed or oversized snapshot fails closed: no workspace lease write is sent. After validation, sole-Pi eligibility uses only the candidate rows' `pane_id` and `agent`: exactly one `agent: "pi"` row must exist and its `pane_id` must be this opaque pane ID. An absent or `null` `agent` is not Pi. Other admitted fields do not affect eligibility.

The outgoing lease contract is unchanged: the write contains only `workspace_id`, `source: "herdr:pi-presence"`, `seq`, `ttl_ms: 30000`, and `tokens: { main_summary }`. The next attempt is scheduled 10 seconds after the previous attempt completes; the list and write each get one five-second, no-retry budget. A pane metadata update only changes the value used by a later heartbeat—it does not synchronously update workspace metadata. Eligibility is a separate read and write, so it is non-atomic and not authority proof. Errors, malformed or oversized lists, zero/multiple/foreign Pi panes, replacement, and teardown never clear workspace metadata; the lease expires.

To render the leased workspace summary and pane summary in Herdr's sidebar, configure Herdr (not this extension):

```toml
[ui.sidebar.spaces]
rows = [["workspace", "$main_summary"]]

[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "tab"], ["agent", "$summary"]]
```

When the workspace row already shows `$main_summary`, leaving only `["agent"]` for Pi avoids duplicate text.

### Conditional sidebar styling for Herdr `>=0.9.0`

The following local Herdr preset keeps the built-in `machine` token and styles only tokens already in this extension's fixed ten-token pane contract. It uses `$summary` text rules in ordered `equals`, `contains`, and `starts_with` order, plus descending numeric `gt` rules for the existing `$context` token:

```toml
[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "machine", "workspace", "tab"],
  [{ token = "$summary", fg = "#89b4fa", rules = [
    { equals = "input", fg = "#f9e2af", bold = true },
    { contains = "terminal failed", fg = "#f38ba8", bold = true },
    { starts_with = "working", fg = "#a6e3a1" },
  ] }],
  [{ token = "$context", fg = "#89b4fa", rules = [
    { gt = 90, fg = "#f38ba8", bold = true },
    { gt = 75, fg = "#f9e2af" },
  ] }],
]
```

Herdr applies the first matching rule only; matching uses the complete token value before display truncation. Each styled token occurrence can have at most `16` ordered rules. The `gt` comparisons are strict numeric comparisons, so descending thresholds preserve the higher-severity match. `state_icon` and composite `git_status` support fixed styling but cannot have `rules`. This preset introduces no custom token: `machine` is a built-in navigation token, while `$summary` and `$context` are existing emitted pane tokens that it styles conditionally. To style terminal-batch loss instead, replace `$context` in the final row with the existing `$v2_terminal_overflow` token and retain descending numeric `gt` rules.

## Notifications

Notifications always use fixed local text, are bounded/deduplicated, and are not retried. An actionable notification may remain pending only for `clamp(PI_HERDR_PRESENCE_TIMEOUT_MS × (PI_HERDR_PRESENCE_MAX_QUEUE + 1), 1000, 30000)` ms; that queue-age timer remains active through fingerprinting, connection, and final pre-write validation alongside a fresh configured socket-attempt timeout begun at dequeue. `pre_dispatch_failure` covers fingerprint, validation, connection, and other failures before `socket.write()` accepts the complete line; it rolls back the pending dedupe/rate reservation, as do `timed_out`, `cancelled`, `coalesced`, `priority_cleanup`, `actionable_displacement`, and `closed`. Only outcomes after that successful physical `socket.write()` commit the reservation: delivery is then unknown, and the notification is neither retried nor rolled back. A local long-running notice has no Herdr sound and is emitted at most once per active parent turn after only accumulated composite `working` time; native/V2 input, blocked attention, failure state, agent end, settlement, replacement, and shutdown pause or clear that budget. Retained activation replay is quiet. `PI_HERDR_PRESENCE_NOTIFICATIONS=false` and policy `disabled` send none. In every enabled policy, live errors and new attention edges remain eligible. A new native or V2 input lifecycle is not blocked by retained failure attention. Nearby live failure-attention state and input edges coalesce to the fixed `Pi needs your input` request-sound alert in either arrival order only when the failure is accepted within 10 ms of that input lifecycle's acceptance edge and the input alert passes policy, dedupe, rate, and physical socket-write commitment; otherwise the failure remains eligible. A `failure:new` state and failed terminal share one notification identity only when they have the same source and generation, their accepted sequences are exactly adjacent, and they arrive within 100 ms. The heuristic retains at most the newest unmatched candidate per source: any intervening same-source event or additional same-kind failure invalidates the older candidate. Semantic exits, non-failed terminals, withdrawal, generation changes, and session replacement also break pairing. The pinned V2 API does not expose producer deactivation/incarnation events, so a silent same-source restart within 100 ms cannot be distinguished; normal producer withdrawal, generation, and session boundaries clear the candidate. Failed terminal alerts remain independent of input admission, and distinct terminal event IDs remain independently eligible.

| Policy | Additionally eligible |
| --- | --- |
| `errors` | Nothing: live terminal failures and new `blocked`, `input_required`, or `failure` attention only. |
| `background` | External success/info and local long-running notices. |
| `settled` | Local successful settlement only. |
| `all` | Local and external success/info plus local long-running notices. |
| `disabled` | Nothing. |

Completion and cancellation remain quiet under the default `errors` policy.
