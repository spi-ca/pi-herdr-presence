# 개발 안내

`bun@1.3.14`를 사용합니다.

```bash
bun install
bun run ci
```

로컬 extension 설치는 [README](../README.md)의 absolute-path `pi install` 명령을 사용하고, 소스 변경 뒤 실행 중인 Pi에서 `/reload`합니다.

주요 모듈:

- `identity.ts`: Linux/macOS Herdr env target 및 Unix socket validation
- `transport.ts`: request-per-connection NDJSON, timeout, bounded keyed queue와 teardown priority request
- `protocol.ts`: Herdr request allowlist와 strict response envelope
- `runtime.ts`: TUI/session epoch lifecycle, native `herdr:blocked`, retained composite state, ready fencing, teardown
- `events.ts`: generic producer parser, generation/sequence fence, tombstone, bounded source slots
- `presentation.ts`: safe state/message/metadata/notification renderer

불변 조건:

- Linux/macOS Unix socket만 지원한다. Windows/named-pipe transport를 추가하지 않는다.
- `HERDR_ENV=1`, `HERDR_SOCKET_PATH`, `HERDR_PANE_ID` 외 target fallback을 만들지 않는다.
- process/CLI/shell execution, polling, persistent connection 또는 subscription을 추가하지 않는다.
- raw prompt, response, tool argument/output, file path를 Herdr text에 넣지 않는다.
- socket 실패는 observer output만 잃고 Pi lifecycle을 실패시키지 않는다.
- lifecycle state, state-attached session ref, session report, metadata `applies_to_source`, release, clear는 모두 정확히 `source: herdr:pi`, `agent: pi`를 사용한다.
- session ref는 `ctx.sessionManager.getSessionFile()` absolute path를 우선하고 ID를 fallback으로 사용하며 매 `agent_start`에 refresh한다.
- metadata teardown은 true clear flags 및 owned metadata token의 null patch 후 priority release를 사용한다.
- managed `herdr-agent-state.ts`가 있으면 marker 유무와 관계없이, 또는 판정할 수 없으면 fail-closed 한다. `ENOENT`만 부재로 인정한다. 이 경우 client, local events, retained session을 만들지 않는다.
- queue/retry는 bounded이며 retry는 한 번뿐이다. 두 시도의 연결/응답 timeout은 `PI_HERDR_PRESENCE_TIMEOUT_MS`를 반씩 사용한다. polling은 없다.
- generic producer는 같은 process trust boundary 안의 협력 component이다. unknown remove는 fence slot을 할당하지 않고, source fence 수는 bounded다.
