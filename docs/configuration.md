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
| `PI_HERDR_PRESENCE_LONG_RUNNING_MS` | `30000` | local long-running 알림 임계값 (1000–300000) |

boolean은 `1/true/yes/on`, `0/false/no/off`만 인정합니다. 정수는 ASCII 양의 정수와 표 범위를 만족해야 합니다.

## 알림 정책

`PI_HERDR_PRESENCE_NOTIFICATIONS=false` 또는 policy `disabled`이면 아래 모든 알림을 막습니다. 그 외에는 policy가 static·bounded 알림 본문을 선택할 뿐 producer text를 전달하지 않습니다.

| policy | error / 사용자 입력·blocked attention | local success | external success·info | local long-running |
| --- | --- | --- | --- | --- |
| `errors` | 알림 | 없음 | 없음 | 없음 |
| `background` | 알림 | 없음 | 알림 | 알림 |
| `settled` | 알림 | 알림 | 없음 | 없음 |
| `all` | 알림 | 알림 | 알림 | 알림 |
| `disabled` | 없음 | 없음 | 없음 | 없음 |

`notification.show`는 dispatch 뒤 timeout·EOF에서 server가 이미 표시했는지 알 수 없으므로 한 번만 시도하고 재시도하지 않습니다. 일반 lifecycle/metadata 요청만 총 timeout을 최대 두 bounded attempt로 나눕니다.

## Herdr 대상과 trust boundary

**Linux와 macOS Unix socket만 지원합니다.** `HERDR_ENV=1`, nonempty absolute `HERDR_SOCKET_PATH`, nonempty `HERDR_PANE_ID`가 모두 필요합니다. Windows 및 named pipe는 명시적으로 거부합니다. 대상 fallback, pane/socket discovery는 없습니다.

각 연결 전/후 현재 UID 소유의 owner-only socket을 검사합니다. 모호한 `.`/`..` lexical traversal은 거부하고 exact lexical ancestor chain과 `realpath`로 해석된 전체 ancestor chain을 모두 검사합니다. symlink ancestor는 root 소유 alias만 허용하며 resolved chain도 교체 불가능해야 합니다. 각 write는 단일 NDJSON request와 단일 strict response를 위한 새 연결입니다. persistent connection, subscription, polling은 사용하지 않습니다.

Pane ID와 socket identity 입력은 최대 256 UTF-8 byte이고, session ID/path는 각각 최대 128/1024 UTF-8 byte입니다. session path가 destination 제한을 넘으면 유효한 ID로 fallback합니다. protocol text field와 16 KiB JSON payload도 UTF-8 byte로 검증하며, validation 또는 serialization 실패는 socket dispatch 없이 해당 observer 출력만 폐기합니다.

`/herdr-presence-doctor`는 설정됨과 실제 ready를 구분하는 read-only 진단입니다. enabled 상태와 `HERDR_ENV`, pane/socket configured 여부는 boolean으로만 표시하고 env 값·socket 경로·pane ID는 출력하지 않습니다. identity/env, managed integration 상태, socket owner/path 안전성을 표시하고, 활성화되어 안전한 socket일 때만 allowlist된 `ping`, `pane.get`으로 pane binding을 확인합니다. `ping`은 exact `{type:"pong",protocol:19|20}`, `pane.get`은 canonical `{type:"pane_info",pane:{pane_id,...}}`의 bounded pane ID가 configured pane과 정확히 일치해야 합니다. `PI_HERDR_PRESENCE_ENABLED=false`여도 command는 진단을 위해 등록되지만 `disabled`와 `not ready`를 명확히 표시하고 socket/ping/pane probe는 모두 `not-run`입니다. managed integration이 `present` 또는 `unknown`이면 socket probe는 실행하지 않고 `socket safety: not-run`으로 표시합니다(`unsafe` 판정이 아님). report/focus/close/cleanup mutation을 수행하지 않습니다.

## Managed integration과 state authority

`$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`(기본 `$HOME/.pi/agent/extensions/...`)가 있으면 marker가 정확한 `HERDR_INTEGRATION_ID=pi`인지와 무관하게 이 package는 runtime state, client, local presence replay를 전혀 만들지 않습니다. `PI_CODING_AGENT_DIR`의 exact `~`/`~/` expansion만 Pi semantics로 따르며, `PI_CODING_AGENT_DIR`/`HOME`의 앞뒤 공백·control/bidi·relative 또는 lexical traversal path는 경로 의미가 모호하므로 `unknown`으로 fail-closed 합니다. marker가 없거나 permission/read/import 오류가 나면 managed integration 부재를 증명할 수 없는 `unknown`으로 fail-closed 합니다. **ENOENT 파일 부재만** managed integration 부재로 판정합니다. managed extension을 제거/비활성화한 뒤 Pi에서 `/reload`해야 합니다.

`pane.report_agent_session`, `pane.report_agent`, `pane.report_metadata`, `pane.release_agent` 모두 `source: "herdr:pi"`, `agent: "pi"`를 사용합니다. session report와 state report는 `getSessionFile()`의 absolute path를 우선하고 session ID를 fallback으로 사용하며, ref는 매 `agent_start`에서 refresh합니다. metadata는 `applies_to_source: "herdr:pi"`를 사용합니다.

연결/응답 timeout은 `PI_HERDR_PRESENCE_TIMEOUT_MS`를 첫 시도와 retry에 반씩 배분합니다(홀수 ms는 retry에 배분). 따라서 기본값은 500ms + 500ms이며, 일반 lifecycle/metadata 요청은 최대 두 번 시도하고 loop는 없습니다. queue 대기 시간은 개별 socket timeout에 포함되지 않습니다. `notification.show`는 dispatch 뒤 결과가 불명확할 때 중복 표시를 피하려고 한 번만 시도하며, teardown의 metadata clear와 priority release도 각각 한 번만 시도합니다.

teardown은 `clear_title: true`, `clear_display_agent: true`, `clear_state_labels: true` 및 15개 owned metadata token—`active`, `completed`, `failed`, `queued`, `cancelled`, `total`, `progress`, `tokens`, `cost`, `context`, `subagents`, `subagent_wait`, `subagent_error`, `subagent_terminal`, `subagent_terminal_at`—의 null patch와 priority release를 각각 한 번씩, close와 함께 **하나의** `PI_HERDR_PRESENCE_TIMEOUT_MS` budget 안에서 순서대로 best-effort 시도합니다. budget 만료 시 active transport를 abort하고 queued work를 정리하며 이후 release/cleanup dispatch를 중단합니다.
