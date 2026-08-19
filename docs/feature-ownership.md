# Lifecycle, privacy, and ownership

`pi-herdr-presence` selects its mode after a non-executing managed-hook probe: exact managed-file presence selects **companion**, exact `ENOENT` selects **standalone**, and unreadable, malformed, ambiguous, unsafe, or timed-out probes select **disabled**. `PI_HERDR_PRESENCE_MODE` can only restrict that result. The legacy `PI_HERDR_PRESENCE_SOLE_REPORTER` setting is accepted for compatibility but is not required for automatic standalone activation. File probing cannot establish that no other process already loaded an integration, so it is not cross-process authority proof.

Standalone owns local `herdr:pi` authority. It clears its current presentation/token projection and the separate legacy token projection before reporting session, state, and metadata; teardown repeats those cleanup envelopes and may clear authority before its deadline.

Companion coexists with the managed authority. Under `herdr:pi-presence`, applied to `herdr:pi`, it owns its bounded exact ten-token metadata and fixed presentation projection; startup and teardown clear only that presentation/token metadata, and policy-gated static notifications remain permitted. It never claims, reports, or clears session or lifecycle authority, and never emits legacy cleanup, authority clear, focus/control, or arbitrary text.

In both modes, the title is exactly `Pi · ${summary}`, derived only from the bounded safe `summary` token; `display_agent` is fixed to `Pi` and `state_labels` are fixed. The extension does not read or project cwd, prompts, session names or paths, task/subagent arguments, output, arbitrary producer identifiers, or raw errors. It uses only fixed display text and bounded metadata.

Terminal records are retained briefly. Their canonical `v2_terminals` encoding remains independent from the transient summary: the summary follows the latest accepted arrival and adds `terminal completed`, `terminal cancelled`, or `terminal failed` only while blocked, input, and failure state do not take precedence. Both clear together.

The extension listens to the shared V2 event bus before activating its consumer. Shared producer lifecycle, receipts, generation/sequence fences, withdrawal, and terminal semantics remain defined by the immutable [canonical V2 lifecycle](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md) and [protocol API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md).

Within one Bun JS realm, the process-global coordinator serializes extension-owned authority startup and teardown, probe/socket unresolved leases, and Herdr sequence allocation across reloads and forks. It is neither cross-process locking nor an authentication or sandbox boundary.
