# 기능 경계와 `pi-cmux` 비교

이 문서는 `pi-cmux-presence`, `pi-subagent` producer 예시, cmux 공식 Pi hook의 기술적 경계를 한곳에 정리합니다. `pi-cmux-presence`는 외부 producer를 import하지 않으며 같은 Pi process의 [versioned event 계약](event-contract.md)만 소비합니다. 구체적인 producer 경계는 [`pi-subagent` 연동 문서](pi-subagent-integration.md)를 함께 참고합니다.

## 구현 범위와 producer 계약

`pi-cmux-presence` 열은 이 저장소에서 구현·검증한 동작입니다. `pi-subagent` 열은 외부 패키지의 현재 구현을 단정하지 않고, generic producer가 지켜야 할 책임과 가능한 예시를 적습니다. 상세 payload와 replay 경계는 [`pi-subagent` generic producer 연동](pi-subagent-integration.md)을 참고하세요.

| 기능 | `pi-cmux-presence` | `pi-subagent` producer 계약·예시 | 비고 |
| --- | --- | --- | --- |
| 부모 Pi 상태·usage | Pi lifecycle/usage를 관찰해 fixed local summary로 surface status를 표시 | 관여하지 않음 | `agent_settled`에서 최종화(미지원 host는 `agent_end` fallback, `isIdle()`이 명시적으로 `false`면 보류); assistant body/prompt/path/tool content는 표시하지 않음 |
| todo 진행률 | 검증한 `todo` 결과에서 count와 `completed/visible`만 계산 | 관여하지 않음 | task 텍스트는 전송하지 않음 |
| subagent 상태 | generic update를 검증해 status/progress로 렌더링하고 remove로 retained 상태를 철회. 정확한 `source.id: "pi-subagent"`는 누적 terminal attention을 한 번으로 집계하고 remove 시 파생 상태도 무효화 | 일반 transient producer는 passive/diagnostic ready capability 확인 뒤 update/remove를 발행하는 방식을 권장. `pi-subagent`는 이전 consumer 호환을 위해 update/remove를 의도적으로 ungated 발행 | package dependency 없음; 구형 consumer는 마지막 update를 session teardown까지 sticky하게 유지할 수 있음; label/kind는 special routing 조건이 아님 |
| root aggregate·child `inherit` | 관여하지 않음; 로드된 경우 수락한 event만 observer로 표시 | root aggregate 소유와 `inherit` child 정책은 producer가 결정 | consumer는 이를 의존·조정·두 package load-order로 검증하지 않음; extension이 없으면 이 consumer 동작도 없음 |
| subagent 실행·취소·결과 | 관여하지 않음 | 실행 패키지가 authority를 유지 | scheduler, lease, reaper, cleanup 등의 실제 범위는 외부 구현의 계약 |
| cmux 상태 스타일 | state별 고정 icon/color/priority, surface-scoped key | cmux 직접 mutation을 요구하지 않음 | V1 socket |
| cmux progress | todo-first deterministic 단일 슬롯 중재; flag가 꺼지면 초기·종료 clear도 생략 | 실제로 보유한 determinate progress만 선택 발행 가능 | cmux workspace당 progress 슬롯 하나 |
| 알림·flash·log | official hook 우선 뒤 channel suppression·레거시 kill switch·policy·capability로 게이팅; exact `pi-subagent` terminal은 의미적으로 한 번만 집계 | foreground/background terminal summary를 동일하게 발행 가능 | `settled`는 local success/error·external error와 finalized local completion인 merged parent/subagent success를 notification; generic external info/success는 제외; replay/cancel/handoff는 `attention: "none"`; 성공 flash는 기본 비활성 |
| Pi PID/lifecycle | 공식 hook 부재 시 기본 활성 fallback | 관여하지 않음 | generic event가 PID/lifecycle command를 만들 수 없음 |
| Feed | 공식 hook 부재 시 opt-in privacy-minimal fallback | Feed 직접 호출을 요구하지 않음 | prompt/input/output/path 제외 |
| metadata block | opt-in 숫자 집계 | 숫자 summary를 event에 포함할 수 있음 | producer text 제외 |
| workspace title | opt-in Pi session name | 관여하지 않음 | 공식 hook 우선 |
| session resume | opt-in, 소유 확인한 exact binding fallback | subagent session resume authority를 이전하지 않음 | 공식 cmux Pi hook 우선 |
| ready/replay | startup에서 advertisement 뒤 consumer-less request 하나를 내고, 외부 request에는 advertisement 하나와 local/todo replay 한 번으로 응답 | matching consumer-less request에 retained summary를 새 sequence와 `attention: "none"`으로 재발행할 수 있음 | `consumer` 없음=request, 있음=passive advertisement; advertisement는 replay/response를 유발하지 않으며 response는 reentrancy-guarded |

## 유연한 연동 원칙

- 공통 채널은 `pi-presence:update:v1`, `pi-presence:remove:v1`, `pi-presence:ready:v1`입니다.
- wire DTO는 두 저장소에 의도적으로 중복 선언합니다. 런타임 package dependency나 shared lifecycle 모듈을 만들지 않습니다.
- `ready.consumer`는 passive/diagnostic UI capability 힌트이며 인증·명령 채널이나 mandatory gate가 아닙니다. 일반 transient producer에는 matching ready capability 확인을 권장하지만, `pi-subagent`는 이전 consumer 호환을 위해 update/remove를 의도적으로 ungated 발행합니다. 생략된 `consumer`는 matching active consumer의 best-effort advertisement와 local/todo replay response를 요청하고, consumer-bearing advertisement는 response나 replay를 유발하지 않습니다. startup advertisement/request는 producer-first, 이 response는 consumer-first load order를 각각 보정합니다.
- `pi-cmux-presence`는 모든 source에 generic update 검증을 적용하고 `pi`·`pi-todo`는 local source로 예약합니다. 단, 정확한 `source.id: "pi-subagent"`의 **attention**만 누적 count·parent settlement 기반 special policy를 사용합니다. 다른 ID와 `source.label`/`source.kind`에는 적용하지 않습니다.
- `pi-subagent` 같은 producer는 필요하면 안정된 `source.id: "pi-subagent"`를 사용할 수 있습니다. 이 ID가 있어도 consumer의 수락·부재가 producer의 root aggregate 소유, 실행·결과·취소·cleanup authority를 바꾸어서는 안 됩니다. managed child가 이 extension을 로드하지 않으면 그 child에 이 consumer의 표시·알림 동작은 요구되지 않습니다.
- event listener, 잘못된 host session ID와 cmux socket 실패는 lifecycle 결과를 바꾸지 않습니다. presence는 focus polling을 하거나 foreground/background handoff를 제어할 trusted read-only capability가 없습니다. focused-banner suppression과 notification retention은 cmux 소유입니다. local Pi와 `pi-subagent` cancellation은 status-only `attention: "none"`으로 남으며 permissive policy도 native notification/flash로 승격하지 않습니다.
- generic producer label은 형식 검증과 byte-safe 축약만 거치므로 producer가 민감정보와 신뢰할 수 없는 원문을 제외합니다.

## `pi-cmux` 비교

| `pi-cmux` 기능군 | 이 저장소의 범위 | 비고 |
| --- | --- | --- |
| Pi status, token/cost, completion attention | 관련 관찰 출력 제공 | presence의 socket 경로 사용 |
| subagent 부모 집계 | generic producer 계약으로 지원 | 외부 producer가 제공한 structured summary만 사용 |
| heuristic turn/tool progress | 의도적으로 제외 | todo와 외부 producer의 determinate progress만 표시 |
| split/tab 생성, 임의 command 실행 | 미지원 | presence observer 범위 밖 |
| `cmux_open_terminal` | 미지원 | user workflow이며 subagent lifecycle registry 밖 |
| `/cmv`, `/cmh`, `/cmo`, `/cmt` | 미지원 | `pi-cmux`를 별도 유지할 때만 사용 |
| review/continue/worktree/zoxide workflow | 미지원 | presence에 추가하지 않음 |
| tool/file별 상세 sidebar log | 부분 지원 | attention log만 제공; raw 도구 인수·출력은 privacy상 제외 |
| 정확한 permission/input-needed 상태 | 부분 지원 | generic producer가 `waiting`/attention을 제공할 수 있으나 Pi 자체의 모든 대기 이유를 추론하지 않음. `pi-subagent`의 `waiting`은 scheduler queued-only이며 handoff 표지가 아님 |
| notification history 읽기·mark-read·jump | 미지원 | 생성만 담당; 사용자 notification center 소유권 유지 |
| surface 이동 뒤 workspace 재탐색 | 미지원 | 현재 session 시작 시 받은 exact workspace/surface를 사용 |
| focus 기반 attention suppress | 미지원 | 신뢰할 수 있는 read-only focus capability가 없어 foreground/background를 판별하지 않음 |

`pi-cmux`의 command/workflow가 필요하면 해당 package를 선택적으로 함께 둘 수 있습니다. 이 경우 status/sidebar/notification 기능은 한쪽만 활성화해 중복을 피합니다.

## 후속 후보

1. exact surface가 다른 workspace로 이동했을 때 read-only topology로 target을 재조정하는 기능
2. producer trust allowlist와 attention rate limit/deduplication 정책
3. `waiting` reason을 input/permission/external wait로 세분화하는 additive contract
4. 여러 determinate producer를 하나의 progress label에 안전하게 요약하는 정책
5. fake event bus와 fake socket을 함께 사용하는 두 package load-order E2E fixture

외부 `pi-subagent` producer가 이 계약을 채택하더라도 child 실행, cancellation, foreground/background 전환, detached promotion, result collection, lease, reaper, target close와 cleanup 같은 authority는 그 producer를 소유한 패키지에 남아야 합니다. 이 저장소는 해당 외부 구현의 실제 범위를 검증하지 않습니다.
