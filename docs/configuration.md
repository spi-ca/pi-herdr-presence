# Herdr socket and authority

The extension activates only when all of these are present:

- `HERDR_ENV=1`
- a nonempty absolute `HERDR_SOCKET_PATH`
- a nonempty `HERDR_PANE_ID`
- a TUI `session_start`

Only Linux and macOS Unix sockets are supported. Each dispatch opens one owner-only, request-per-connection socket. No target fallback, socket discovery, persistent connection, subscription, polling, CLI, or shell execution exists. Socket, response, validation, and serialization failures are observer-only.

## Pi runtime compatibility

The required non-optional peer is `@earendil-works/pi-coding-agent` `^0.82.0`. The extension derives a terminal outcome from `agent_end` and settles it only on the runtime-provided `agent_settled` lifecycle callback.

| Variable | Default | Meaning |
| --- | ---: | --- |
| `PI_HERDR_PRESENCE_ENABLED` | `true` | Enable the observer |
| `PI_HERDR_PRESENCE_SOLE_REPORTER` | `false` | Required operator opt-in: local reporting may start only when this is true and the managed file is exactly absent |
| `PI_HERDR_PRESENCE_TIMEOUT_MS` | `1000` | Total bounded lifecycle/metadata connection-response budget |
| `PI_HERDR_PRESENCE_MAX_QUEUE` | `16` | Latest-write-wins pending entries |
| `PI_HERDR_PRESENCE_METADATA` | `true` | Send ordinary nine-token metadata projection (startup/teardown stale cleanup still runs) |
| `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` | `1500` | Terminal projection retention before a quiet rerender |
| `PI_HERDR_PRESENCE_MAX_LABEL_CHARS` | `96` | Static local presentation bound |
| `PI_HERDR_PRESENCE_NOTIFICATIONS` | `true` | Global static-toast kill switch |
| `PI_HERDR_PRESENCE_NOTIFY_POLICY` | `errors` | `errors`, `background`, `settled`, `all`, or `disabled` |
| `PI_HERDR_PRESENCE_LONG_RUNNING_MS` | `30000` | Long-running threshold for eligible advanced policies |

## Notifications

Under the default `errors` policy, only live, receipt-accepted V2 edges can produce a toast; activation replay only reconstructs pane state and metadata. That policy sends one static alert for a terminal failure or a new `attention.reason` of `blocked`, `input_required`, or `failure`, while start, progress, ordinary completion, and long-running work remain quiet. The opt-in `background` and `all` policies also permit the local long-running timer to send its static alert; this timer is not a V2-edge or replay notification. `settled` permits its local-success behavior but not the long-running timer. `disabled` or `PI_HERDR_PRESENCE_NOTIFICATIONS=false` sends none.

Each alert has fixed privacy-safe text, is deduplicated by a bounded TTL/LRU edge fence, and passes through a session-local rate backstop. A dispatched `notification.show` is never retried because a timeout cannot establish whether the toast was already visible.

## Managed authority

`$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` is a competing managed integration and therefore blocks local reporting. The reviewed upstream asset has `HERDR_INTEGRATION_ID=pi` and active lifecycle/socket behavior; it is not a passive marker. Because a file probe cannot rule out an already-loaded asset after deletion, local reporting is disabled by default. It starts only when an operator has set `PI_HERDR_PRESENCE_SOLE_REPORTER=1` **and** an exact managed-asset `ENOENT` proves absence. Unknown contents, probe errors, unsafe configured paths, unreadable files, and a bounded probe wall-deadline expiry are all fail-closed. A timed-out underlying probe holds a process-wide lease, preventing re-probes until it settles.

## Same-runtime reload coordination

A strict, frozen coordinator is installed once at non-configurable `globalThis[Symbol.for("pi-herdr-presence/process-coordinator/v1")]`. Cache-busted module reloads and forked extension instances in that Bun runtime reuse it after ABI-shape validation. It owns the authority startup/teardown lane, managed-hook and socket-fingerprint unresolved leases, and the monotonic Herdr sequence allocator. Lifecycle callbacks initiate this work detached and do not make Pi await probes, socket I/O, or cleanup. Shutdown invalidates its ownership and reserves its teardown in that lane synchronously; a newer startup queued afterwards waits for the old client's bounded cleanup. A generation fence means an old shutdown that is queued after a newer authority claim closes its own client without emitting stale remote cleanup. This trusts other code in the same runtime and is not a cross-process lock. The coordinator does not invoke or await Pi host callbacks.

When local reporting is allowed, reports use `source: "herdr:pi"` and `agent: "pi"`. The teardown-only `pane.clear_agent_authority` envelope instead strictly contains only `pane_id`, `source: "herdr:pi"`, and `seq`. Session references are `agent_session_id` only. Paths and user/producer text are neither read for reporting nor sent to Herdr.
