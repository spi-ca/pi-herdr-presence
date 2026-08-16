# 설정과 활성화 조건

모든 설정은 `PI_HERDR_PRESENCE_*` namespace만 사용합니다. 잘못된 값은 안전한 기본값으로 돌아갑니다.

| 변수 | 기본값 | 설명 |
| --- | ---: | --- |
| `PI_HERDR_PRESENCE_ENABLED` | `true` | extension observer 활성화 |
| `PI_HERDR_PRESENCE_TIMEOUT_MS` | `1000` | 두 번의 요청에 나누어 적용하는 총 연결/응답 timeout (100–30000) |
| `PI_HERDR_PRESENCE_MAX_QUEUE` | `16` | latest-write-wins 대기 항목 (1–128) |
| `PI_HERDR_PRESENCE_NOTIFICATIONS` | `true` | `notification.show` 전역 kill switch |
| `PI_HERDR_PRESENCE_NOTIFY_POLICY` | `background` | `errors`, `background`, `settled`, `all`, `disabled` |
| `PI_HERDR_PRESENCE_METADATA` | `true` | `pane.report_metadata` 보고 |
| `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` | `1500` | terminal rerender 지연 (0–60000) |
| `PI_HERDR_PRESENCE_MAX_LABEL_CHARS` | `96` | UI label code-point 상한 (16–256) |

boolean은 `1/true/yes/on`, `0/false/no/off`만 인정합니다. 정수는 ASCII 양의 정수와 표 범위를 만족해야 합니다.

## Herdr 대상과 trust boundary

**Linux와 macOS Unix socket만 지원합니다.** `HERDR_ENV=1`, nonempty absolute `HERDR_SOCKET_PATH`, nonempty `HERDR_PANE_ID`가 모두 필요합니다. Windows 및 named pipe는 명시적으로 거부합니다. 대상 fallback, pane/socket discovery는 없습니다.

각 연결 전/후 현재 UID 소유의 owner-only socket 및 교체 불가능한 parent chain을 검사합니다. 각 write는 단일 NDJSON request와 단일 strict response를 위한 새 연결입니다. persistent connection, subscription, polling은 사용하지 않습니다.

## Managed integration과 state authority

`$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`(기본 `$HOME/.pi/agent/extensions/...`)가 있으면 marker가 정확한 `HERDR_INTEGRATION_ID=pi`인지와 무관하게 이 package는 runtime state, client, local presence replay를 전혀 만들지 않습니다. marker가 없거나 permission/read/import 오류가 나면 managed integration 부재를 증명할 수 없는 `unknown`으로 fail-closed 합니다. **ENOENT 파일 부재만** managed integration 부재로 판정합니다. managed extension을 제거/비활성화한 뒤 Pi에서 `/reload`해야 합니다.

`pane.report_agent_session`, `pane.report_agent`, `pane.report_metadata`, `pane.release_agent` 모두 `source: "herdr:pi"`, `agent: "pi"`를 사용합니다. session report와 state report는 `getSessionFile()`의 absolute path를 우선하고 session ID를 fallback으로 사용하며, ref는 매 `agent_start`에서 refresh합니다. metadata는 `applies_to_source: "herdr:pi"`를 사용합니다.

연결/응답 timeout은 `PI_HERDR_PRESENCE_TIMEOUT_MS`를 첫 시도와 retry에 반씩 배분합니다(홀수 ms는 retry에 배분). 따라서 기본값은 500ms + 500ms이며, 시도는 정확히 두 번이고 loop는 없습니다. queue 대기 시간은 이 socket 연결/응답 timeout에 포함되지 않습니다.

teardown은 `clear_title: true`, `clear_display_agent: true`, `clear_state_labels: true` 및 `active`, `completed`, `failed`, `queued`, `cancelled`, `total`, `progress`, `tokens`, `cost`, `context` metadata token의 null patch를 보낸 뒤 priority release합니다.
