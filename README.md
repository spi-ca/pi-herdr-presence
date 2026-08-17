# pi-herdr-presence

`pi-herdr-presence`는 Pi TUI의 축약된 local presence를 Herdr에 request-per-connection Unix 소켓으로만 보고하는 로컬 확장입니다. **Linux와 macOS만 지원**하며 Windows/named pipe는 지원하지 않습니다. CLI·shell·자식 프로세스·polling·subscription은 사용하지 않습니다.

## 설치와 reload

이 패키지는 GitHub 저장소에서 설치합니다.

```bash
pi install git:github.com/spi-ca/pi-herdr-presence
# 현재 프로젝트에만 설치
pi install -l git:github.com/spi-ca/pi-herdr-presence
```

로컬 checkout을 개발할 때는 저장소의 **absolute path**를 설치합니다.

```bash
pi install /absolute/path/to/pi-herdr-presence
```

코드나 package 설정을 변경한 실행 중인 Pi에서는 `/reload`를 실행합니다. 제거는 설치에 사용한 source로 합니다.

```bash
pi remove git:github.com/spi-ca/pi-herdr-presence
pi remove -l git:github.com/spi-ca/pi-herdr-presence
```

## 활성화와 소유권

확장은 `HERDR_ENV=1`, absolute `HERDR_SOCKET_PATH`, nonempty `HERDR_PANE_ID`, 그리고 `session_start` context의 `mode === "tui"`가 모두 있을 때만 동작합니다.

Herdr-managed `$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`가 있으면 marker가 정확히 `HERDR_INTEGRATION_ID=pi`인지와 무관하게 이 확장은 완전히 비활성입니다. marker 없음과 probe 오류는 모두 fail-closed이며, **ENOENT 파일 부재만** local integration을 허용합니다. managed integration을 제거/비활성화하고 Pi에서 `/reload`한 뒤에만 이 확장을 사용하세요.

모든 lifecycle 요청은 단일 authority인 `source: "herdr:pi"`, `agent: "pi"`를 사용합니다.

- session report와 state report는 `ctx.sessionManager.getSessionFile()`의 absolute path를 우선하고 session ID를 fallback으로 사용합니다. session ref는 매 `agent_start`에서 새로 고칩니다.
- metadata는 `applies_to_source: "herdr:pi"`를 사용합니다.
- teardown은 `clear_title`, `clear_display_agent`, `clear_state_labels`와 15개 owned token(`active`…`context`, `subagents`, `subagent_wait`, `subagent_error`, `subagent_terminal`, `subagent_terminal_at`)의 null patch와 priority release를 각각 한 번씩, close와 함께 하나의 configured timeout budget 안에서 best-effort로 시도합니다. 만료 시 transport를 abort하고 이후 cleanup dispatch를 중단합니다.

## 동작

- `pane.report_agent`, `pane.report_agent_session`, `pane.report_metadata`, 선택 `notification.show`를 보냅니다.
- local Pi lifecycle, `herdr:blocked`, retained `pi-presence:update:v1` producer 상태를 `working`/`blocked`/`idle` composite state로 렌더합니다. native blocked counter는 root TUI session에서만 처리합니다.
- 소켓·응답·protocol validation·JSON serialization·queue 오류는 observer 출력만 잃으며 Pi lifecycle을 실패시키지 않습니다. 일반 lifecycle/metadata 요청은 최대 두 번 시도하며, 두 시도의 연결/응답 timeout은 `PI_HERDR_PRESENCE_TIMEOUT_MS`를 반씩 사용합니다(기본 500ms + 500ms). 사용자에게 이미 보였는지 알 수 없는 `notification.show`와 teardown의 clear/release는 각각 한 번만 시도하며 재시도하지 않습니다.
- `pi-subagent`는 import하지 않는 generic producer이며 source generation/sequence fence와 고정 terminal coalescing window로 처리합니다. 선택 summary companion은 task/output/path를 복사하지 않는 bounded pane metadata만 만듭니다.
- `/herdr-presence-doctor`는 read-only exact protocol-19/20 `pong`/canonical `pane_info`로 enabled/configured와 실제 ready, managed integration, socket safety, pane binding을 구분합니다. env 값은 출력하지 않으며 disabled, managed/ambiguous integration은 socket/ping/pane probe를 `not-run`으로 남깁니다.

## 문서와 검증

- [설정과 보안 경계](docs/configuration.md)
- [generic event contract](docs/event-contract.md)
- [개발 안내](docs/development.md)
- [기능 소유권](docs/feature-ownership.md)
- [pi-subagent generic producer integration](docs/pi-subagent-integration.md)

```bash
bun install
bun run ci
```
