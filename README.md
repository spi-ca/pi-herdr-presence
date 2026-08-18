# pi-herdr-presence

`pi-herdr-presence` is a Pi TUI extension that reports local presence to Herdr through its supplied Unix socket. It supports Linux and macOS only; it never runs a CLI, shell, child process, poller, or subscription.

## Install

```bash
pi install git:github.com/spi-ca/pi-herdr-presence
# project-local
pi install -l git:github.com/spi-ca/pi-herdr-presence
```

Use an absolute checkout path for local development and run `/reload` after changing it.

## Pi runtime requirement

This extension requires `@earendil-works/pi-coding-agent` `^0.82.0`. Its lifecycle contract uses `agent_end` only to derive the terminal outcome and requires the runtime's `agent_settled` callback to settle that outcome; no compatibility fallback is installed.

## Herdr behavior

The extension runs only with `HERDR_ENV=1`, an absolute `HERDR_SOCKET_PATH`, a nonempty `HERDR_PANE_ID`, and a TUI `session_start`. Each request uses a new socket connection; observer, validation, serialization, and socket failures never fail Pi lifecycle work.

It reports `pane.report_agent_session`, `pane.report_agent`, `pane.report_metadata`, best-effort `notification.show`, and teardown `pane.clear_agent_authority`. Session references are ID-only (`agent_session_id`); paths, prompts, outputs, errors, and producer labels never enter Herdr metadata.

Each ordinary metadata report uses Herdr v8's supported fixed presentation fields (`title: "Pi"`, `display_agent: "Pi"`, and fixed state labels) plus the exact nine-token map. The fixed nine-token projection is:

`v2_progress`, `v2_attention`, `v2_interaction`, `v2_subagents`, `v2_terminals`, `v2_terminal_overflow`, `tokens`, `cost`, `context`.

Before restoring session authority, startup retains a bounded, ordered, derived lifecycle-edge queue. It always completes cleanup, then the session-authority report, then the startup projection and queued-edge replay; no callback can publish ahead of that commit. Startup sends two bounded, non-retried cleanup patches: the current V2 presentation-clear flags plus all nine `null` tokens, then the prior extension's exact legacy-only allowlist (`active`, terminal/progress/subagent counters and flags). The chunks stay separate (9 and 12 tokens), contain no paths or text, and settle before any session report or fixed presentation. Every render includes all nine keys, with absent values set to `null`. `v2_terminals` uses the shared canonical encoding, retains the newest records, and is shortened by omitting oldest records until its UTF-8 value is at most Herdr's 80-byte limit; each omission increments bounded `v2_terminal_overflow`. Teardown repeats both cleanup chunks within one aggregate deadline. Only if those stages leave time and the client remains open does it make at most one priority, non-retried `pane.clear_agent_authority` attempt with exactly `pane_id`, `source: "herdr:pi"`, and `seq`; deadline expiry can prevent that dispatch, so it is not an unconditional exactly-once action. Cleanup remains active when ordinary metadata projection is disabled.

## Managed authority and notifications

A Herdr-managed `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts` is authoritative and disables this extension. The local reporter is fail-closed by default: set `PI_HERDR_PRESENCE_SOLE_REPORTER=1` only when an operator has verified it is the sole pane reporter. Local reporting starts only when that explicit opt-in **and** an exact `ENOENT` for the managed asset both hold. Any other probe result—including a present, unreadable, malformed, ambiguous, unsafe, or timed-out asset—remains blocked; an unresolved probe lease prevents further probes until the underlying filesystem operation settles.

Within one Bun runtime, a non-configurable `globalThis[Symbol.for("pi-herdr-presence/process-coordinator/v1")]` coordinator survives cache-busted reloads and `/fork`. It serializes authority startup and teardown, leases one unresolved managed-hook probe and socket fingerprint, and allocates strictly increasing Herdr sequences. Lifecycle hooks start and shutdown this work detached, so they never make Pi await probing, socket I/O, or cleanup. `session_shutdown` first invalidates its ownership and reserves its old cleanup slot synchronously, so a subsequently queued runtime cannot start authority work until bounded old cleanup completes. Authority generations make a shutdown that arrives late from an old runtime close only its local resources rather than clear the newer pane authority. This is same-runtime coordination, not cross-process locking; it does not await Pi host callbacks.

**Threat model:** Same-JS-realm extensions are trusted arbitrary code. The coordinator is not an authentication, authorization, or sandbox boundary. Its immutable shape and proxy checks fail closed only to prevent accidental or structural misuse; they cannot protect against a trusted extension that deliberately controls the shared realm.

For live (never replayed), receipt-accepted V2 edges, the default `errors` policy sends one static best-effort alert for terminal failures and new `attention.reason` values of `blocked`, `input_required`, or `failure`. It keeps start, progress, ordinary completion, and long-running work quiet. The opt-in `background` and `all` policies also permit the local long-running timer to send its static alert; it is a timer exception, not a replayed V2 edge. Alerts are bounded by per-edge TTL/LRU deduplication and a session rate limit, are never retried, and contain no producer text.

## Documentation

The pinned shared V2 sources are the canonical [protocol API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [consumer/producer lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal encoding fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).

- [Herdr configuration, socket, and authority](docs/configuration.md)
- [Nine-token projection and canonical V2 references](docs/event-contract.md)
- [Lifecycle and privacy behavior](docs/feature-ownership.md)
- [Development and verification](docs/development.md)

```bash
bun install --frozen-lockfile
bun run ci
bun pm pack --dry-run
```
