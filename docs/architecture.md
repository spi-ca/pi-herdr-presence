# Architecture and module roles

This document is the authoritative overview of component boundaries and lifecycle ordering. See [configuration](configuration.md) for environment behavior, [event contract](event-contract.md) for Herdr envelopes, and [feature ownership](feature-ownership.md) for authority and privacy limits.

## Components

```mermaid
flowchart LR
  Hooks[Pi lifecycle hooks] --> Runtime["PresenceRuntime<br/>src/runtime.ts"]
  Bus[Shared @pi/presence V2 bus] --> Runtime
  Todo[Pi Todo result] --> TodoAdapter["TodoProgressAdapter<br/>src/todo.ts"]
  TodoAdapter --> Bus
  Runtime --> Presentation["presentation.ts<br/>bounded summary and tokens"]
  Runtime --> Lease["WorkspaceSummaryLease<br/>src/workspace-summary.ts"]
  Presentation --> Client["PresenceClient<br/>src/client.ts"]
  Lease --> Client
  Client --> Protocol["protocol.ts<br/>exact envelopes"]
  Protocol --> Transport["HerdrSocketTransport<br/>src/transport.ts"]
  Transport --> Pane[Herdr pane]
  Transport --> Workspace[Herdr workspace]
```

| Module | Responsibility | Does not own |
| --- | --- | --- |
| `src/runtime.ts` | Pi hook lifecycle, V2 consumer activation, local Pi/Todo producers, aggregate state, startup/teardown fencing, and notification sequencing | Wire encoding or socket I/O |
| `src/workspace-summary.ts` | Immediate and completion-relative workspace-summary lease cadence, timer fencing, and latest-summary retention | Eligibility, wire encoding, or workspace clearing |
| `src/presentation.ts` | Fixed presentation and bounded V2 token/summary projection | Herdr requests or producer protocol semantics |
| `src/client.ts` | Mode-specific pane calls, cleanup ordering, workspace eligibility/read-write flow, and output fencing | Untrusted input parsing or timer scheduling |
| `src/protocol.ts` | Exact request/response schemas, fixed token grammar, and bounded values | Connections, retries, or mode selection |
| `src/transport.ts` | One-request-per-connection Unix-socket exchange, validation, bounded queue, deadlines, and priority cleanup | Request meaning or authority |
| `src/config.ts`, `src/official-hook.ts`, `src/identity.ts` | Configuration parsing, managed-marker detection, and Herdr identity/socket safety | Runtime output after an ambiguous result |
| `src/todo.ts` | One stable Todo owner; structural traversal of `params`/`error` within depth, field, and array-count bounds (not string-byte bounds); task count and allowed-key checks; derives only IDs, statuses, and counts | Traversing ignored task-field values or copying, interpreting, retaining, or projecting task text, arguments, or nested values |
| `src/notification-policy.ts` | Fixed-text notification policy, deduplication, and rate limits | Producer-provided notification content |

## Startup and ordinary projection

The V2 consumer is active before its retained state is projected. Startup keeps ordinary output closed until cleanup, applicable standalone authority, and a stable initial render finish. Pending live notification edges drain, local Pi/Todo producer candidates activate, and pending lifecycle edges replay. The final `idle`/`running` pane state—or, for a replayed pending `agent_start`, that start's final pane state—is synchronously enqueued before the independent workspace eligibility attempt is launched without awaiting it. A stalled `pane.list` therefore cannot delay those local steps.

```mermaid
sequenceDiagram
  participant Pi as Pi hooks / V2 bus
  participant R as PresenceRuntime
  participant C as PresenceClient
  participant H as Herdr pane
  participant W as Herdr workspace

  Pi->>R: session_start
  R->>R: validate identity and managed marker; activate V2 consumer
  R->>C: current metadata clear
  alt standalone
    R->>C: legacy metadata clear, session/state authority
  end
  C->>H: ordered pane requests
  R->>C: initial fixed presentation + ten tokens
  C->>H: pane.report_metadata
  R->>R: open ordinary output; drain queued live notifications
  R->>R: activate local Pi/Todo producer candidates
  alt pending agent_start
    R->>C: replay agent_start; enqueue its final pane state
    C->>H: pane.report_metadata
  else no pending agent_start
    R->>C: enqueue final idle/running pane state
    C->>H: pane.report_metadata
  end
  R-)C: launch workspace-summary attempt (not awaited)
  C->>W: pane.list(workspace_id)
  opt exactly this one reported agent: pi pane
    C->>W: workspace.report_metadata(main_summary, ttl 30 s)
  end
```

`metadata=false` suppresses ordinary live pane metadata and the workspace `main_summary` lease. It does **not** suppress owned startup and teardown cleanup: the current metadata clear still runs in both active modes, and standalone still clears its separate legacy projection. Lifecycle authority behavior remains mode-dependent.

## Workspace lease cadence

The lease starts only after the initial pane projection and pending notifications have entered the transport queue. It retains the latest bounded pane `summary`; a pane update changes that retained value, but does not synchronously write workspace metadata. The next attempt is immediate at startup or scheduled **10 seconds after the preceding attempt completes**. Each attempt performs `pane.list` and, only when eligible, `workspace.report_metadata`; each request has a single five-second budget. This leaves the normal read + write + cadence below the 30-second TTL.

```mermaid
sequenceDiagram
  participant L as WorkspaceSummaryLease
  participant C as PresenceClient
  participant W as Herdr workspace

  L->>C: publish latest summary
  C->>W: pane.list(workspace_id), max 5 s
  alt sole own reported Pi pane
    C->>W: report main_summary, ttl_ms=30000, max 5 s
  else ineligible or invalid/error
    C-->>L: no write
  end
  C-->>L: attempt completed
  L->>L: wait 10 s
  L->>C: next attempt uses latest summary
```

Attempts never overlap. Replacement and teardown stop the timer, fence the lease, and actively cancel its keyed `workspace-pane-list` and `workspace-main-summary` transport requests, including an active request and any newer queued request with the same key. There is deliberately no workspace clear: failed, ineligible, replaced, and torn-down leases expire naturally. Because eligibility is a read followed by a write, it is non-atomic and is not authority proof.

## Authority and teardown

Mode selection is fail-closed and is detailed in [configuration](configuration.md#managed-marker-and-mode-selection). Both modes own a bounded presentation/token projection; only standalone owns `herdr:pi` session and lifecycle authority.

```mermaid
flowchart TD
  Start[Validated TUI session] --> Probe{Managed marker result}
  Probe -->|present| Companion[Companion]
  Probe -->|absent| Standalone[Standalone]
  Probe -->|unknown| Disabled[Disabled]
  Companion --> CP[Own herdr:pi-presence presentation/tokens]
  Standalone --> SP[Own herdr:pi lifecycle + presentation/tokens]
  CP --> CT[Teardown: own current projection only]
  SP --> ST[Teardown: current clear, legacy clear, then authority clear if deadline permits]
```

Teardown fences ordinary output first. Companion clears only its `herdr:pi-presence` presentation/tokens. Standalone clears its current projection, then its legacy token projection, and may clear `herdr:pi` authority before the bounded teardown deadline. Neither mode clears workspace metadata; the workspace lease uses expiry instead.
