# 설정과 활성화 조건

모든 설정은 `PI_HERDR_PRESENCE_*` namespace만 사용합니다. 잘못된 값은 안전한 기본값으로 돌아갑니다.

| 변수 | 기본값 | 설명 |
| --- | ---: | --- |
| `PI_HERDR_PRESENCE_ENABLED` | `true` | extension observer 활성화 |
| `PI_HERDR_PRESENCE_TIMEOUT_MS` | `1000` | 두 번의 요청에 나누어 적용하는 총 연결/응답 timeout (100–30000) |
| `PI_HERDR_PRESENCE_MAX_QUEUE` | `16` | latest-write-wins 대기 항목 (1–128) |
| `PI_HERDR_PRESENCE_NOTIFICATIONS` | `true` | `notification.show` 전역 kill switch |
| `PI_HERDR_PRESENCE_NOTIFY_POLICY` | `errors` | `errors`, `background`, `settled`, `all`, `disabled` |
| `PI_HERDR_PRESENCE_METADATA` | `true` | `pane.report_metadata` 보고 |
| `PI_HERDR_PRESENCE_FINAL_CLEAR_MS` | `1500` | terminal rerender 지연 (0–60000) |
| `PI_HERDR_PRESENCE_MAX_LABEL_CHARS` | `96` | UI label code-point 상한 (16–256) |
| `PI_HERDR_PRESENCE_LONG_RUNNING_MS` | `30000` | `background`/`all` policy에서만 쓰는 local long-running 알림 임계값 (1000–300000) |

boolean은 `1/true/yes/on`, `0/false/no/off`만 인정합니다. 정수는 ASCII 양의 정수와 표 범위를 만족해야 합니다.

## 알림 정책

`PI_HERDR_PRESENCE_NOTIFICATIONS=false` 또는 policy `disabled`이면 아래 모든 알림을 막습니다. 그 외에는 policy가 static·bounded 알림 본문을 선택할 뿐 producer text를 전달하지 않습니다.

| policy | error / 사용자 입력·blocked attention | local success | external success·info | local long-running |
| --- | --- | --- | --- | --- |
| `errors` (기본) | 알림 | 없음 | 없음 | 없음 |
| `background` (호환 고급 설정) | 알림 | 없음 | 알림 | 알림 |
| `settled` | 알림 | 알림 | 없음 | 없음 |
| `all` | 알림 | 알림 | 알림 | 알림 |
| `disabled` | 없음 | 없음 | 없음 | 없음 |

기본 `errors` 정책은 **오류, 새 사용자 입력 lifecycle, 새 native/general blocked 전환만** 알립니다. start, 보통 progress, 30초 long-running, replay, 보통 success completion은 pane state/metadata에만 남고 조용합니다. 이전의 외부 success·info/long-running 동작이 필요한 경우에만 명시적으로 `background`, `settled`, `all`을 선택합니다.

retained `source.kind === "interaction" && state === "waiting"` update는 attention 값과 관계없이 사용자 입력이 필요한 pane state입니다. 각 open input lifecycle에서 처음 effective해진 live `attention === "info"` request만 `request` sound 알림을 만들 수 있습니다. replay/update의 `attention:"none"` 자체는 pane을 `blocked`와 static `Pi needs your input` 메시지로 복원할 뿐 알림을 만들지 않지만, 그 lifecycle에 아직 알림을 전달하지 않았다면 이후 첫 live `info`가 한 번 알릴 수 있습니다. best-effort 알림 시도 뒤 높은 sequence나 native/generic 중복 신호는 재시도하지 않습니다. producer label/prompt/content는 복사하지 않습니다. error와 native local-blocked 상태는 input-needed 문구와 알림보다 우선하며, 아직 알림을 시도하지 않은 live request는 그 우선 상태가 해제되어 effective해질 때 한 번 알릴 수 있습니다. 모든 retained generic/native input 신호가 해제되면 다음 lifecycle을 다시 알릴 수 있습니다. interaction이 아닌 `waiting`+`info`는 일반 `working` 상태와 generic `done` notification을 유지합니다.

외부 producer의 알림 후보는 policy 전에 source/generation/attention의 의미 전환으로 기록하며, 최대 64 source의 LRU fence와 짧은 timer coalescing window로 묶습니다. 따라서 기본 policy가 success/info를 표시하지 않아도 그 전환 뒤의 새 error는 다시 후보가 됩니다. 같은 상태의 높은 sequence는 재알림하지 않고, 같은 burst에서는 error가 success/info보다 우선합니다. 이 처리는 event/socket/timer 기반이며 polling하지 않습니다.

정책·dedupe 뒤의 마지막 안전망으로 session마다 최근 60초에 최대 8개의 일반 알림만 보냅니다. `error`, 사용자 입력, native/general blocked의 각 첫 actionable 전환은 이 한도를 예약하지 않고 항상 한 번 통과하며, `none`, remove/re-add, producer generation 변경, input lifecycle 재개도 한도를 초기화하지 않습니다. session teardown 뒤에만 상태를 비웁니다.

`notification.show`는 dispatch 뒤 timeout·EOF에서 server가 이미 표시했는지 알 수 없으므로 한 번만 시도하고 재시도하지 않습니다. 일반 lifecycle/metadata 요청만 총 timeout을 최대 두 bounded attempt로 나눕니다.

## Herdr 대상과 trust boundary

**Linux와 macOS Unix socket만 지원합니다.** `HERDR_ENV=1`, nonempty absolute `HERDR_SOCKET_PATH`, nonempty `HERDR_PANE_ID`가 모두 필요합니다. Windows 및 named pipe는 명시적으로 거부합니다. 대상 fallback, pane/socket discovery는 없습니다.

각 연결 전/후 현재 UID 소유의 owner-only socket을 검사합니다. 모호한 `.`/`..` lexical traversal은 거부하고 exact lexical ancestor chain과 `realpath`로 해석된 전체 ancestor chain을 모두 검사합니다. symlink ancestor는 root 소유 alias만 허용하며 resolved chain도 교체 불가능해야 합니다. 각 write는 단일 NDJSON request와 단일 strict response를 위한 새 연결입니다. persistent connection, subscription, polling은 사용하지 않습니다.

Pane ID와 socket identity 입력은 최대 256 UTF-8 byte이고, session ID/path는 각각 최대 128/1024 UTF-8 byte입니다. session path가 destination 제한을 넘으면 유효한 ID로 fallback합니다. protocol text field와 16 KiB JSON payload도 UTF-8 byte로 검증하며, validation 또는 serialization 실패는 socket dispatch 없이 해당 observer 출력만 폐기합니다.

이 확장은 command, skill, prompt, LLM-callable tool을 등록하지 않습니다. lifecycle hook과 same-process event-bus 구독만 사용하며 모델의 기본 context를 확장하지 않습니다.

## Managed integration과 state authority

`$PI_CODING_AGENT_DIR/extensions/herdr-agent-state.ts`(기본 `$HOME/.pi/agent/extensions/...`)가 있으면 marker가 정확한 `HERDR_INTEGRATION_ID=pi`인지와 무관하게 이 package는 runtime state, client, local presence replay를 전혀 만들지 않습니다. `PI_CODING_AGENT_DIR`의 exact `~`/`~/` expansion만 Pi semantics로 따르며, `PI_CODING_AGENT_DIR`/`HOME`의 앞뒤 공백·control/bidi·relative 또는 lexical traversal path는 경로 의미가 모호하므로 `unknown`으로 fail-closed 합니다. marker가 없거나 permission/read/import 오류가 나면 managed integration 부재를 증명할 수 없는 `unknown`으로 fail-closed 합니다. **ENOENT 파일 부재만** managed integration 부재로 판정합니다. managed extension을 제거/비활성화한 뒤 Pi에서 `/reload`해야 합니다.

`pane.report_agent_session`, `pane.report_agent`, `pane.report_metadata`, `pane.release_agent` 모두 `source: "herdr:pi"`, `agent: "pi"`를 사용합니다. session report와 state report는 `getSessionFile()`의 absolute path를 우선하고 session ID를 fallback으로 사용하며, ref는 매 `agent_start`에서 refresh합니다. metadata는 `applies_to_source: "herdr:pi"`를 사용합니다.

연결/응답 timeout은 `PI_HERDR_PRESENCE_TIMEOUT_MS`를 첫 시도와 retry에 반씩 배분합니다(홀수 ms는 retry에 배분). 따라서 기본값은 500ms + 500ms이며, 일반 lifecycle/metadata 요청은 최대 두 번 시도하고 loop는 없습니다. queue 대기 시간은 개별 socket timeout에 포함되지 않습니다. `notification.show`는 dispatch 뒤 결과가 불명확할 때 중복 표시를 피하려고 한 번만 시도하며, teardown의 metadata clear와 priority release도 각각 한 번만 시도합니다.

teardown은 `clear_title: true`, `clear_display_agent: true`, `clear_state_labels: true` 및 15개 owned metadata token—`active`, `completed`, `failed`, `queued`, `cancelled`, `total`, `progress`, `tokens`, `cost`, `context`, `subagents`, `subagent_wait`, `subagent_error`, `subagent_terminal`, `subagent_terminal_at`—의 null patch와 priority release를 각각 한 번씩, close와 함께 **하나의** `PI_HERDR_PRESENCE_TIMEOUT_MS` budget 안에서 순서대로 best-effort 시도합니다. budget 만료 시 active transport를 abort하고 queued work를 정리하며 이후 release/cleanup dispatch를 중단합니다.
