# pi-cmux-presence

Pi 세션과 같은 Pi 프로세스 안의 선택 생산자가 내는 짧은 상태를 cmux에 **Unix 소켓으로만** 전달하는 로컬 Pi 패키지입니다. 프로세스나 cmux CLI를 실행하지 않으며 Pi TUI, LLM 도구, 프롬프트, 스키마를 추가하지 않습니다.

저장소: <https://github.com/spi-ca/pi-cmux-presence>

## 설치

`package.json`의 Pi peer dependency는 optional `*`이므로 설치 가능한 Pi 최소 버전을 메타데이터로 강제하지 않습니다. 개발 의존성은 `^0.82.0`이고 현재 `bun.lock`은 `0.82.1`을 해석하지만, 실제 사용하는 Pi와의 호환성은 별도로 확인해야 합니다. `cmux`가 제공한 `CMUX_WORKSPACE_ID`·`CMUX_SURFACE_ID`와 현재 사용자만 접근할 수 있는 Unix 소켓 환경이 필요합니다. 이 패키지는 `private: true`이므로 npm 설치를 제공하거나 안내하지 않습니다.

Pi extension을 포함한 제3자 패키지는 **full system access**로 실행됩니다. 설치 전 소스와 Git ref를 검토하고 신뢰할 수 있는 패키지만 설치하세요.

```bash
# v0.1.0 전역 설치
pi install git:github.com/spi-ca/pi-cmux-presence@v0.1.0

# 갱신: `v0.1.0` 부분을 존재하는 release tag로 바꾸어 실행
pi install git:github.com/spi-ca/pi-cmux-presence@v0.1.0

# 제거
pi remove git:github.com/spi-ca/pi-cmux-presence
```

프로젝트에만 설치하려면 프로젝트 루트에서 설치 명령에 `-l`을 붙입니다.

```bash
pi install -l git:github.com/spi-ca/pi-cmux-presence@v0.1.0
```

### 로컬 경로 설치·개발

개발 중에는 현재 디렉터리를 로컬 패키지로 설치할 수 있습니다. Pi는 경로를 복사하지 않고 참조합니다.

```bash
bun install
bun run ci
pi install /absolute/path/to/pi-cmux-presence
# 프로젝트 범위 로컬 설치
pi install -l /absolute/path/to/pi-cmux-presence
```

코드나 패키지 설정을 바꾼 뒤 실행 중인 Pi에서 `/reload`를 실행합니다. 일회성 진입점 점검에는 `pi -e /absolute/path/to/pi-cmux-presence/index.ts`를 사용할 수 있습니다.

## 동작 요약

- `CMUX_WORKSPACE_ID`와 `CMUX_SURFACE_ID`가 모두 RFC variant UUID v1–v5이고 안전한 Unix 소켓을 찾을 때만 전송합니다. 대상·포커스·`/tmp/cmux.sock`을 추측하지 않습니다.
- 상태 키는 `surfaceId:sourceId`를 SHA-256으로 해시한 `pi-presence:<hash>`입니다. `set_status`는 해당 surface의 `--panel=<CMUX_SURFACE_ID>`를 포함하므로 상태 표시는 surface 범위입니다.
- 상태별 cmux 스타일은 `idle`(gray/circle/10), `waiting`(amber/clock/20), `running`(blue/play/30), `success`(green/check/20), `error`(red/x/40), `cancelled`(gray/minus/20)입니다.
- 내장 Pi lifecycle 관찰은 기본 활성(`PI_CMUX_PRESENCE_NATIVE_LIFECYCLE=true`)입니다. Pi PID와 `running`/`idle` lifecycle을 panel 범위로 보냅니다. `idle`은 cmux가 Pi가 유휴 상태임을 알 수 있게 하는 관찰 신호일 뿐, 이 패키지가 surface를 hibernate·resume하거나 Pi 작업을 제어한다는 뜻은 아닙니다.
- 최종 상태는 settlement를 의미하는 `agent_settled`에서 확정합니다. host context가 `isIdle()`을 제공해 명시적으로 `false`를 반환하면 확정하지 않으며, host가 그 hook 등록을 지원하지 않을 때만 `agent_end` fallback을 사용합니다. assistant 토큰, 양수 비용, 가능한 context 사용률과 `tool_result.isError`를 반영합니다. 내장 Pi 이벤트는 progress를 추정하지 않습니다.
- host session ID가 이벤트 계약의 safe text 조건(1–96 Unicode code points)을 만족하지 않거나 조회 중 오류가 나면 해당 세션의 presence를 fail-closed로 비활성화하고 기존에 소유한 출력을 정리합니다. Pi lifecycle 오류로 전파하지 않습니다.
- 상태·progress·notification·auto-title 문자열은 control/bidi 문자를 정규화하고 Unicode code point를 자르지 않으면서 설정의 글자 수와 목적지별 UTF-8 byte 한도를 모두 만족하도록 축약합니다.
- 모든 관찰 쓰기는 best-effort입니다. 소켓 오류·시간 초과·큐 포화·응답 오류는 Pi 작업을 실패시키지 않으며 해당 출력만 유실될 수 있습니다. 같은 key로 대기 중인 UI 쓰기는 하나의 promise를 공유하며 최신 요청으로 교체되는 latest-write-wins 방식으로 병합되고, 이미 실행 중인 요청은 교체하지 않습니다. 이는 소켓 **전송** 병합이며, `pi-subagent`의 terminal 집계·시간 창 병합과는 별개입니다.
- 외부 producer는 선택 사항입니다. 특히 `pi-subagent`는 이 패키지의 dependency나 import가 아니며, 같은 프로세스 event bus에 V1 summary를 발행할 때에만 선택적으로 연동됩니다. 정확히 `source.id: "pi-subagent"`인 입력에는 누적 terminal attention을 안전하게 한 번으로 묶는 소비자 측 정책이 적용됩니다. 상세 계약은 [`docs/pi-subagent-integration.md`](docs/pi-subagent-integration.md)를 참고하세요.
- 검토한 외부 cmux child profile은 정확히 `PI_CMUX_PROFILE=subagent-child-v1`일 때만 인식합니다. 이 profile과 정확한 `PI_CMUX_NOTIFY_LEVEL=disabled` 또는 `PI_CMUX_SIDEBAR_FLASH=disabled` 조합은 각각 native notification 또는 native flash만 억제하고, sidebar status·progress·log는 유지합니다. 이는 환경 호환 경계일 뿐 dependency나 child lifecycle authority가 아닙니다. 세부 precedence는 [`docs/configuration.md`](docs/configuration.md)를 참고하세요.
- local Pi sidebar는 상태별로 `Pi · Idle`/`Waiting`/`Writing response`/`Response ready`/`Needs attention`/`Cancelled`의 canonical fixed wording을 사용합니다. native notification은 title `Pi`와 같은 summary body를 사용하며, terminal sidebar는 `PI_CMUX_PRESENCE_FINAL_CLEAR_MS` 뒤 지웁니다. notification 보존과 focused-banner suppression은 cmux 소유입니다.
- `PI_CMUX_PRESENCE_NOTIFY_POLICY`의 기본값은 계속 `background`입니다. opt-in `settled`는 local success/error와 external error를 notification으로 허용하고 일반 external info/success는 허용하지 않습니다. 단, 성공한 부모 settlement와 exact `pi-subagent` 성공 집계가 병합된 결과는 finalized local completion으로 취급합니다. official hook precedence 뒤 child channel suppression, legacy kill switch, policy, V2 capability가 모두 gate합니다.
- local Pi와 정확한 `pi-subagent` producer의 cancellation은 status-only이며 `attention: "none"`입니다. `all`/`attention` 정책이어도 notification·flash를 만들지 않습니다.

### 공식 cmux hook 우선순위

공식 cmux hook(`cmux-session.ts`의 `cmux-pi-session-extension-marker v2`)이 감지되고 `CMUX_PI_HOOKS_DISABLED`가 `1`이 아니면 그 hook이 우선합니다. 이 패키지는 native lifecycle·feed·meta block·auto-title·resume fallback·내장 Pi completion attention을 보내지 않습니다. 일반 외부 producer의 status/progress/attention은 계속 처리하지만, 정확히 `source.id: "pi-subagent"`의 버퍼된 성공 attention은 native notification/flash로 보내지 않고(필요하면 log만), 그 source의 집계 error는 정책·capability가 허용하는 한 한 번 계속 보냅니다. 감지 경로, 정책과 marker 부재 시 동작은 [`docs/configuration.md`](docs/configuration.md)를 참고하세요.

## cmux 프로토콜

초기화 때 V2 `system.capabilities`를 조회하고, 성공적으로 광고된 메서드만 선택 V2 호출에 사용합니다. 광고가 없거나 응답이 형식에 맞지 않으면 선택 V2 기능은 호출하지 않습니다. V1은 LF-구분 텍스트를 소켓에 직접 쓰며 각 응답은 정확히 대문자 `OK` 한 줄이어야 합니다.

| 계층 | 현재 사용 명령/메서드 | gate |
| --- | --- | --- |
| V1 | `set_status`, `clear_status`, `set_progress`, `clear_progress`, `log` | 각각 sidebar/progress/log 설정; progress가 꺼지면 초기·종료 clear도 보내지 않음 |
| V1 native | `set_agent_pid`, `set_agent_lifecycle`, `clear_agent_pid` | native lifecycle 설정과 공식 hook 부재 |
| V1 opt-in | `report_meta_block`, `clear_meta_block` | meta block 설정과 공식 hook 부재 |
| V2 probe | `system.capabilities` | 초기화마다 시도 |
| V2 attention | `notification.create_for_surface`, `surface.trigger_flash` | 해당 기능 flag와 서버 capability |
| V2 opt-in | `feed.push`, `workspace.set_auto_title`, `surface.resume.get/set/clear` | 해당 flag, 공식 hook 부재, 서버 capability |

V1의 workspace 대상은 항상 `--tab=<CMUX_WORKSPACE_ID>`입니다. `set_status`와 V1 native lifecycle 명령(`set_agent_pid`, `set_agent_lifecycle`, `clear_agent_pid`)에는 `--panel=<CMUX_SURFACE_ID>`도 포함됩니다. V2의 surface 메서드는 workspace/surface UUID를 모두 포함합니다.

## 프로세스-로컬 이벤트

`pi-presence:update:v1`과 consumer-side `pi-presence:remove:v1`은 같은 Pi 프로세스 event bus 입력입니다. remove는 이미 수락된 외부 source의 retained 상태만 철회하며, payload에 표시·attention 데이터를 담지 않습니다. V1 payload, 공유 순서 fence, 삭제와 progress 선택 규칙은 [이벤트 계약](docs/event-contract.md)을 따릅니다. 내장 source `pi`와 todo source `pi-todo`는 예약되어 외부 update·remove payload로는 수락하지 않습니다.

소비자는 세션 시작 시 frozen ready 광고를 낸 뒤 frozen consumer-less replay/discovery request를 정확히 한 번 냅니다. 자기 request는 exact identity로 무시합니다. `consumer`가 없는 외부 strict V1 request에는 frozen 광고 하나와 retained local/todo state의 한 번의 `attention: "none"` replay로 응답합니다. `consumer`가 있는 광고는 passive capability advertisement일 뿐 response나 replay를 만들지 않아 multi-producer fan-out을 막습니다. 이는 실행·취소·재시도 권한을 주지 않습니다.

```ts
pi.events.emit("pi-presence:ready:v1", {
  version: 1,
  sessionId,
  consumer: {
    id: "pi-cmux-presence",
    capabilities: ["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"],
  },
});
```

일반 producer는 matching consumer-less request를 받으면 retained 상태를 새 sequence 및 `attention: "none"`으로 재발행할 수 있습니다. startup advertisement/request는 producer-first, 외부 request response는 consumer-first load order를 보정합니다. stale·malformed·비활성 session request는 무시하고, event emit 실패는 선택적 discovery/replay 출력만 잃게 하며 Pi 작업을 실패시키지 않습니다. transient producer의 capability 확인은 권장이며 mandatory gate가 아닙니다. `pi-subagent`는 이전 consumer 호환성을 위해 ungated update/remove를 의도적으로 내며, 이전 consumer는 마지막 update를 session teardown까지 sticky하게 유지합니다. 이 consumer 저장소에는 ask-user producer나 그 lifecycle 구현이 없습니다.

## 개인정보와 전송 범위

내장 Pi producer와 todo adapter의 기본 상태 출력은 source label/state/count/선택 usage·progress·attention처럼 계약에서 허용한 축약 데이터만 사용합니다. local Pi sidebar/notification에는 assistant response body·preview, 사용자 프롬프트, raw error, 파일 경로, 도구 인수·출력, task 설명·제목, credential을 수집하거나 소켓으로 보내지 않습니다.

같은 프로세스의 외부 producer가 제공하는 `source.label`과 `progress.label`은 형식·control/bidi·길이를 검증하고 목적지 byte 한도로 축약하지만, 내용의 민감도를 판별하거나 redaction하지는 않습니다. 수락된 label은 status, progress, log, notification으로 cmux에 표시될 수 있으므로 외부 producer가 비밀, credential, 경로, prompt나 신뢰할 수 없는 원문을 넣지 않아야 합니다.

비기본 기능(`PI_CMUX_PRESENCE_FEED`, `PI_CMUX_PRESENCE_META_BLOCK`, `PI_CMUX_PRESENCE_AUTO_TITLE`, `PI_CMUX_PRESENCE_RESUME_FALLBACK`)은 명시적으로 opt-in해야 추가 데이터(feed의 session/tool 식별자와 cmux가 이미 제공한 `_source`·workspace/surface ID, meta block의 숫자 집계, auto-title의 session name, resume fallback의 checkpoint ID)를 cmux에 보냅니다. 어느 것도 프롬프트나 tool 인수·결과는 넣지 않습니다. 각 기능이 정확히 보내는 필드와 token 형식 제약은 [`docs/configuration.md`](docs/configuration.md)를 참고하세요.

## 문서

README는 진입점만 담고, 세부 내용은 주제별 문서로 나눕니다.

| 주제 | 문서 |
| --- | --- |
| 설정과 소켓 조건 | [`docs/configuration.md`](docs/configuration.md) |
| 이벤트 계약 | [`docs/event-contract.md`](docs/event-contract.md) |
| 개발 워크플로와 프로젝트 구조 | [`docs/development.md`](docs/development.md) |
| `pi-subagent` generic producer 연동 | [`docs/pi-subagent-integration.md`](docs/pi-subagent-integration.md) |
| 기능 경계와 `pi-cmux` 비교 | [`docs/feature-ownership.md`](docs/feature-ownership.md) |
| Mermaid 다이어그램 원본과 렌더링 | [`docs/diagram/README.md`](docs/diagram/README.md) |
| 변경 이력 | [`CHANGELOG.md`](CHANGELOG.md) |
| 에이전트용 문서 작성 지침(벤더) | [`docs/guidelines/`](docs/guidelines/) |

## 검증

```bash
bun run ci
bun pm pack --dry-run
```

자동 검증은 consumer 쪽 generic producer shape, 검토한 exact child-profile suppression, fake Unix socket과 정적 namespace를 사용합니다. 실행 중인 `pi-subagent`·`pi-cmux`의 load order나 root aggregate/child `inherit` 공존, cmux 서버의 live 연동은 이 저장소에서 검증하거나 주장하지 않습니다.

## 라이선스

MIT. 자세한 내용은 [`LICENSE`](LICENSE)를 참고하세요.
