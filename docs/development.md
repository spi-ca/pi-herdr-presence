# Development and verification

Use `bun@1.3.14`.

```bash
bun install --frozen-lockfile
bun run ci
bun pm pack --dry-run
```

`@pi/presence` is pinned exactly to `github:spi-ca/pi-presence#v2-20260818-2`. Do not use a range, sibling path dependency, or the retired package name. Following the Pi `0.84.2` package convention, the non-optional `@earendil-works/pi-coding-agent` peer range is `*`; development types use `^0.84.2` and the current frozen lock resolution. Keep `agent_end` terminal derivation and `agent_settled` settlement as separate callbacks; do not add event-registration fallback or runtime-version shims.

Extension scope is Herdr socket transport, managed-authority detection, lifecycle-to-pane reporting, fixed safe presentation, exact ten-token projection, and the workspace-summary lease. Shared V2 protocol and lifecycle behavior are canonical in the pinned [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json). Upstream Herdr and Pi core are out of scope.

## Checks and coverage

| Command | Purpose | Output |
| --- | --- | --- |
| `bun run lint` | Biome lint with warnings treated as errors | Terminal output |
| `bun run check` | TypeScript no-emit check | Terminal output |
| `bun run test` | Full automated Bun suite | Terminal output |
| `bun run coverage` | Full suite with Bun text coverage | Coverage table on stdout |
| `bun run coverage:check` | CI coverage gate | Coverage table and pass/fail message on stdout/stderr |
| `bun run ci` | Lint, typecheck, then coverage gate | Combined terminal output |

The coverage gate requires at least **85% function coverage** and **90% line coverage**. It independently sanitizes stdout and stderr, rejects any totals row on stdout, and accepts exactly one Bun text-reporter `All files` totals row on stderr; it does not create a persistent coverage report directory.

Tests are intentionally layered:

- **Unit/module tests** cover configuration parsing, marker and identity validation, V2/presentation/protocol reducers, notification policy, Todo aggregate-only projection, queue semantics, and `WorkspaceSummaryLease` completion-relative timer behavior.
- **Integration-like Unix-socket tests** use real local Unix sockets to exercise request framing, EOF/multiple-line rejection, fingerprint validation, deadlines, queue recovery, client envelopes, runtime startup/teardown, and workspace `pane.list` eligibility. They do not require a real Herdr service.
- **Opt-in real smoke** uses a real Herdr socket and shared live producers. It is manual only and excluded from `bun run test`, coverage, and automatic CI.

## Manual real-Herdr smoke

Use only a disposable standalone pane. Before any real relay, effective notifications must be disabled; set `PI_HERDR_PRESENCE_NOTIFICATIONS=false` (preferred) or `PI_HERDR_PRESENCE_NOTIFY_POLICY=disabled`. The harness refuses to run unless the guard is exactly `PI_HERDR_LIVE_SMOKE=disposable-standalone-pane`, `PI_HERDR_PRESENCE_METADATA=true`, notifications are effectively disabled, `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` is at least `1000`, the managed marker is exactly absent, and the effective configuration selects standalone. It remains a disposable standalone/manual check: it is not a service, test fixture, or CI job.

The owner-only relay handles one framed request per connection, uses a per-request timeout, rejects malformed, multiple-line, and oversized responses, and rechecks the real socket fingerprint before and after connecting before it relays the request. It verifies startup/teardown ordering and exact projection envelopes.

```bash
HERDR_ENV=1 \
HERDR_SOCKET_PATH=/absolute/path/to/socket \
HERDR_WORKSPACE_ID=disposable-workspace \
HERDR_PANE_ID=disposable-pane \
PI_HERDR_PRESENCE_METADATA=true \
PI_HERDR_PRESENCE_NOTIFICATIONS=false \
PI_HERDR_PRESENCE_FINAL_CLEAR_MS=1000 \
PI_HERDR_LIVE_SMOKE=disposable-standalone-pane \
bun run smoke:live
```

Never target a production or shared pane. This command is never automatic CI. By default the harness expects sibling `pi-ask-user` and `pi-subagent` checkouts; use `PI_ASK_USER_ROOT` and `PI_SUBAGENT_ROOT` to provide explicit absolute checkout roots when needed.

## Test conventions for new modules and scripts

Keep deterministic logic in focused module tests. For timer code such as `src/workspace-summary.ts`, inject a scheduler seam and assert completion-relative scheduling, latest-value behavior, non-overlap, failure recovery, and stop fencing. For runtime wiring, use a fake local socket plus the scheduler seam; test replacement and teardown cannot dispatch a stale workspace write.

Place distributable developer utilities in `scripts/` and invoke them through a named `package.json` script. Keep smoke harnesses out of `test/`: they must require an explicit destructive-safety opt-in and must not be collected by `bun test`. `scripts/check-coverage.ts` is the CI gate; preserve its explicit threshold and reporter-total validation when changing it.

Same-JavaScript-realm extensions are trusted arbitrary code. The process coordinator is fail-closed defense against accidental or structural misuse, not protection from an extension deliberately controlling the shared realm.
