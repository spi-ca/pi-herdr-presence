# Development and verification

Use `bun@1.3.14`.

```bash
bun install --frozen-lockfile
bun run ci
bun pm pack --dry-run
```

`@pi/presence` is pinned exactly to `github:spi-ca/pi-presence#v2-20261013-1`. Do not use a range, sibling path dependency, or the retired package name. `test` and coverage commands use Bun's `--isolate` per-file fresh global object because the shared presence registry and process coordinator are intentionally process-global within an extension runtime; this prevents unrelated test files from inheriting their retained state. Pi development types are pinned exactly to `@earendil-works/pi-coding-agent@1.2.0`; the non-optional peer range remains `*`. Register `ui_prompt_start` and `ui_prompt_end` directly through the Pi `1.2.0` `ExtensionAPI`; do not add event-registration fallback, unsafe casts, or runtime-version shims. Keep `agent_end` terminal derivation and `agent_settled` settlement as separate callbacks; continuation preserves the active long-running budget until settlement. Pass the settlement's `aborted` boolean through the same fenced live/pending reducer; an older event without that field preserves terminal derivation. Provider-free lifecycle tests cover tool/retry/compaction-window cancellation, startup replay, and stale ownership. See [nested tool-result semantics](event-contract.md#pi-tool-result-and-continuation-semantics) for count projection and parent failure handling.

Extension scope is Herdr socket transport, managed-authority detection, lifecycle-to-pane reporting, fixed safe presentation, exact ten-token projection, aggregate native TUI prompt and accepted V2 `ask_user` waiting state, and the workspace-summary lease. Shared V2 protocol and lifecycle behavior are canonical in the pinned [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20261013-1/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20261013-1/docs/lifecycle.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20261013-1/fixtures/normative.json). Upstream Herdr and Pi core are out of scope.

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

## Herdr 0.9.5 호환성 확인

호환성 대상은 Herdr `v0.9.5` / protocol `22`입니다. 로컬에 설치된 `0.9.3`, `0.9.4`, `0.9.5` 바이너리에서 `api schema --json`을 추출하고 `jq -S`로 정규화한 결과, 세 버전의 전체 schema SHA-256은 모두 다음과 같았습니다.

```text
9e2af207e9aa8183d4aeca5fde9cc48e7909bb40cdbd7cf21608a6d3ea78075b
```

mise에 각 버전과 jq가 설치된 환경에서 다음과 같이 재현할 수 있습니다. 파이프 중간 실패를 놓치지 않도록 Bash의 `pipefail`을 사용합니다.

```bash
set -euo pipefail
for version in 0.9.3 0.9.4 0.9.5; do
  echo "Herdr $version"
  mise exec "herdr@$version" -- herdr api schema --json | jq -S . | sha256sum
done
```

`PaneInfo`의 필수 필드·선택 필드도 기존 validator와 일치하므로 allowlist를 넓히거나 새 protocol을 허용하지 않습니다. managed integration asset `9`, standalone/companion authority, metadata와 workspace lease 계약, `resume_argv` 미전송 정책은 유지합니다. 과거 버전으로 고정된 resume 안전성 설계의 근거 링크는 역사적 조사 자료로 유지합니다.

이 비교는 **바이너리에 포함된 API 계약 확인**이지 실행 중인 서버의 버전이나 실제 UI 동작 확인이 아닙니다. 설치·mise 기본 선택이 `0.9.5`여도 기존 서버와 현재 셸의 PATH는 `0.9.4`일 수 있습니다. `mise exec herdr@0.9.5 -- herdr --version`으로 바이너리를, 같은 실행 접두사의 `herdr status server`로 서버 버전을 별도로 확인하세요. 업데이트만으로 기존 서버가 교체됐다고 간주하지 않습니다. 실제 `0.9.5` standalone/companion 동작은 아래의 별도 opt-in 검증 범위이며, 서버 재시작·handoff는 사용자 승인 없이 수행하지 않습니다. 아래 harness는 standalone만 검증합니다.

## Manual real-Herdr smoke

Use only a disposable standalone pane. In its configured workspace, the current `HERDR_PANE_ID` must be the sole `agent: "pi"` pane in Herdr's complete `pane.list` response; non-Pi panes may exist, but another Pi pane makes the workspace lease ineligible. Before any real relay, effective notifications must be disabled; set `PI_HERDR_PRESENCE_NOTIFICATIONS=false` (preferred) or `PI_HERDR_PRESENCE_NOTIFY_POLICY=disabled`. The harness refuses to run unless the guard is exactly `PI_HERDR_LIVE_SMOKE=disposable-standalone-pane`, `PI_HERDR_PRESENCE_METADATA=true`, notifications are effectively disabled, `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` is at least `1000`, the managed marker is exactly absent, and the effective configuration selects standalone. It remains a disposable standalone/manual check: it is not a service, test fixture, or CI job.

The owner-only relay handles one framed request per connection, uses a per-request timeout, rejects malformed, multiple-line, and oversized responses, and rechecks the real socket fingerprint before and after connecting before it relays the request. It verifies startup/teardown ordering and exact projection envelopes. For the workspace lease, it captures and validates the full workspace-scoped `pane.list` response, confirms that the current pane is the sole `agent: "pi"` row, then verifies the `workspace.report_metadata` lease and its exact acknowledgement.

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

## Automatic CI compatibility matrix

Push and pull-request CI runs `bun run ci`, `bun pm pack --dry-run`, and a provider-free tarball smoke. The smoke installs the tarball in an isolated temporary consumer with lifecycle scripts disabled, injects exact Pi runtime peers, imports it, and invokes only a registration stub; it removes `KIRO_API_KEY`, sets `PI_OFFLINE=1`, and never invokes the real-Herdr smoke harness. Both lanes log the selected Bun version and the path and version of `cc`.

| Lane | Bun | Pi development graph | Install |
| --- | --- | --- | --- |
| locked baseline | 1.3.14 (`packageManager`) | `pi-coding-agent` exact 1.2.0 lockfile graph | `bun install --frozen-lockfile` |
| older compatibility | 1.4.2 | the declared Pi devDependency selected exactly at 0.85.1 in an ephemeral graph | `bun install --no-save` |

Each lane's repository-install graph verifier recursively inspects hoisted links and Bun `.bun` nested symlinks against the selected exact stack mapping: `1.2.0` for the locked baseline and `0.85.1` for older compatibility. Every package in that selected mapping must be installed at its exact version. Separately, the tarball smoke deliberately injects the complete selected exact Pi graph and declared non-Pi peers into its isolated consumer as a deterministic compatibility harness against wildcard or transitive drift; it is not a minimal-peer-install proof. The older compatibility lane does not allow the `*` peer range to choose a latest package: it temporarily selects every declared Pi development package at exact `0.85.1`, restores the manifest, and confirms that the lockfile is unchanged. This is the hosted-CI configuration; it is not evidence of a local reinstall or a live-Herdr/provider check.

The older lane preserves a regression check for hosts before nested tool calls and before the settlement `aborted` field while the wildcard host peer remains declared. Neither selected graph includes `pi-client` or `pi-protocol`: these are not runtime dependencies of the available `pi-coding-agent` packages at these versions. The current graph includes `pi-codemode` and `pi-mcp`. Pi 1.2 removed `@earendil-works/chord` from the current runtime graph; only the older lane pins and verifies it. Graph checks reject unexpected installed Pi or chord packages.

Herdr package smoke intentionally tests only import/default-factory execution with no identity (inert registration), not a real host session or socket. Unix-socket lifecycle tests exercise active hook wiring; the manual live-Herdr smoke remains opt-in. A successful package smoke does not prove native Pi nested-tool execution or real Herdr interoperability.
