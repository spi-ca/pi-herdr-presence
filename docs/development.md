# Development

Use `bun@1.3.14`.

```bash
bun install --frozen-lockfile
bun run ci
bun pm pack --dry-run
```

`@pi/presence` is pinned exactly to `github:spi-ca/pi-presence#v2-20260818-2`. Do not use a range, a sibling path dependency, or the retired package name.

The non-optional Pi runtime peer is `@earendil-works/pi-coding-agent` `^0.82.0`. The frozen lock resolves the development range to `0.82.1`; its installed `ExtensionAPI` types declare `on("agent_settled", ...)`. Keep `agent_end` terminal derivation and `agent_settled` settlement as separate callbacks; do not add an event-registration fallback or runtime-version shim.

The extension-specific code is limited to Herdr socket transport, managed-authority detection, lifecycle-to-pane reporting, fixed safe display fields plus a summary-derived standalone title, and the ten-token projection. Shared protocol, lifecycle, receipt, fence, and terminal rules are canonical at the immutable [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json). Upstream Herdr and Pi core source, APIs, and UI are out of scope; do not modify or document them as extension deliverables.

Same-JS-realm extensions are trusted arbitrary code. The process coordinator is therefore not an authentication, authorization, or sandbox boundary. Its frozen-descriptor and proxy validation is fail-closed defense against accidental or structural misuse only; do not represent it as protection from an extension that deliberately controls the shared JavaScript realm.

For a socket smoke test with a real Herdr target:

```bash
HERDR_ENV=1 HERDR_SOCKET_PATH=/path/to/socket HERDR_PANE_ID=pane \
  bun test/live-herdr-presence-producers.ts
```

The live harness is standalone-only: it requires exact managed-hook absence, which selects standalone automatically. It uses an event-driven owner-only temporary proxy and verifies standalone startup order (current clear, legacy clear, session report, agent report, ordinary metadata). At teardown it verifies standalone cleanup, then authority clear only when the aggregate deadline permits it. It checks exact metadata envelopes, all ten keys, terminal projection, withdrawal, the summary-derived title and fixed display fields, and privacy; it does not poll or invoke a CLI/process. Companion behavior, including its policy-gated static notifications, is covered deterministically by fake owner-only socket tests rather than this live harness.

`test/process-coordinator.test.ts` imports cache-busted copies of the coordinator, managed-hook probe, and transport. It verifies the immutable process-global installation, one unresolved probe/fingerprint lease across module instances, monotonic sequence allocation with an internally sampled clock, ordered detached old-cleanup/new-startup execution, and the generation fence that makes a stale teardown close locally rather than clear newer authority. Lifecycle callbacks never await this authority lane. The proxy-focused coordinator tests verify that hostile global or method proxies fail closed without invoking their traps or accessors.
