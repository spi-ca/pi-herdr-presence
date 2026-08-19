# Lifecycle, authority, and privacy ownership

This is the authoritative ownership and privacy document. See [architecture](architecture.md) for flow, [configuration](configuration.md) for mode selection, and [event contract](event-contract.md) for the emitted envelopes.

## Mode authority

The managed-marker probe selects **companion** only for exact managed presence, **standalone** only for exact initial absence, and **disabled** for every ambiguous result. Explicit mode configuration can restrict that result but cannot upgrade it. The probe is not cross-process authority proof.

| Capability | Standalone | Companion |
| --- | --- | --- |
| Source for owned metadata | `herdr:pi` | `herdr:pi-presence`, applied to `herdr:pi` |
| Fixed presentation and ten-token pane metadata | Owns | Owns separately |
| Session and lifecycle/state reports | Owns `herdr:pi` | Never emits |
| Current metadata/presentation cleanup | Owns | Owns only its separate projection |
| Legacy token cleanup | Owns | Never emits |
| Authority clear | May emit before teardown deadline | Never emits |
| Policy-gated static notification | May emit | May emit |
| Workspace `main_summary` | May lease, subject to eligibility | May lease, subject to eligibility |

Both modes stop the workspace timer and fence in-flight eligibility at replacement/teardown, actively cancelling both active and newer queued same-key workspace requests. Neither clears workspace metadata: `main_summary` expires after its 30-second TTL. `metadata=false` suppresses ordinary metadata and the workspace lease, but owned startup and teardown cleanup remains active.

The process-global coordinator serializes extension-owned authority startup/teardown, unresolved probe and socket-fingerprint leases, and Herdr sequence allocation within one Bun JavaScript realm. It is not cross-process locking, authentication, authorization, or a sandbox boundary.

## Data minimization

The extension projects only fixed display text and bounded derived metadata. It does not project cwd, prompts, session names or paths, task/subagent arguments, output, arbitrary task/subagent content identifiers, or raw errors.

Required opaque Herdr pane and workspace IDs are retained and sent only for their protocol roles. Standalone also retains its session ID for lifecycle authority; sequence, protocol, and terminal ordinals, plus derived counts and tokens, are retained or emitted as needed. These required identity, ordering, and derived values are distinct from arbitrary task/subagent text or content identifiers.

The Todo adapter structurally traverses Todo `params` and `error` with depth, field, and array-count bounds, but string leaves have no byte bound. It checks task count and allowed task keys, but does not traverse ignored task-field values. It semantically consumes only task IDs and statuses plus aggregate visible/active/completed counts to derive progress. It does **not** copy, semantically interpret, retain, or project task text (`content`, `subject`, `title`, `description`, or `activeForm`), task arguments/parameters, metadata, tags, dates, owners, dependencies, or other nested values. It retains stable Todo tool provenance—`path`, `source`, `scope`, and `origin`—only as an in-process owner key for the root session and never projects it. The owner reset at the next root-session boundary permits that new session's Todo implementation while stale callbacks remain epoch-fenced.

The pane title is derived only from the bounded canonical `summary`; `display_agent` and state labels are constants. The workspace lease can carry only that same summary as `main_summary`. Notifications use static local text rather than producer payload.

## Event and lifecycle boundary

The extension subscribes as a consumer of the shared V2 bus before it activates local Pi and Todo producers. Retained V2 activation replay reconstructs state but never creates notifications. Live accepted terminal failures and new attention edges are evaluated after the initial projection according to the configured policy.

The extension does not import or control `pi-subagent`. Producer ownership, lifecycle, and terminal encoding are defined by the pinned shared V2 contract; see [shared producer integration](pi-subagent-integration.md).
