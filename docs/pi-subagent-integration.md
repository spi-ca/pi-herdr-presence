# `pi-subagent` 선택 producer 연동과 attention UX

## 범위와 의존성

`pi-cmux-presence`는 `pi-subagent`를 import하거나 dependency로 선언하지 않습니다. `pi-subagent`가 같은 Pi 프로세스 event bus에서 [`pi-presence:update:v1`](event-contract.md)을 발행하는 경우에만 이 consumer가 선택적으로 summary를 렌더링하며, `pi-presence:remove:v1`으로 그 retained summary를 철회할 수 있습니다. 따라서 이 문서는 외부 패키지의 설치, production entrypoint, 실행 방식 또는 현재 구현 parity를 보장하지 않습니다.

일반 producer는 현재 `sessionId`, 자신이 소유한 `generation`·단조 증가 `sequence`, 비예약 `source.id`, state/count를 넣어 발행합니다. `pi`와 `pi-todo`는 예약 source라 외부 입력으로 수락되지 않습니다. `pi-subagent` 연동에 사용할 source ID는 정확히 `"pi-subagent"`입니다. label과 kind는 표시용 safe text일 뿐 routing authority가 아니며, `"pi-subagent"`와 비슷한 다른 ID에는 아래의 special attention 정책이 적용되지 않습니다.

```ts
pi.events.emit("pi-presence:update:v1", {
  version: 1,
  sessionId,
  generation,
  sequence: ++sequence,
  source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
  state: "running",
  counts: { active, completed, failed, queued, cancelled, total },
  // 실제 producer가 보유한 경우에만 포함
  progress: total > 0 ? { value: completed / total } : undefined,
  attention: "none",
});
```

이 event는 cmux API나 lifecycle 명령 채널이 아닙니다. `pi-subagent` producer가 이를 발행해도 feed, meta block, workspace title, resume fallback 또는 live cmux target/focus mutation이 활성화되지 않습니다. 해당 기능은 `pi-cmux-presence` 자신의 opt-in 설정·capability와 별개이며, focus를 읽을 신뢰할 수 있는 read-only capability도 없으므로 focus 기반 suppress나 foreground로의 handoff는 지원하지 않습니다.

root aggregate와 child `inherit` 같은 실행·집계 규칙은 producer 쪽의 책임이며 이 consumer가 의존하거나 조정하는 계약이 아닙니다. 이 저장소는 그런 외부 규칙이나 두 package의 실제 load order를 실행해 검증하지 않습니다. managed child가 이 extension을 로드하지 않았다면 status/progress/log/notification/flash를 포함한 이 consumer 동작은 요구되지 않으며, root aggregate·child lifecycle은 그대로 producer 소유입니다.

## scheduler summary 규칙

`waiting`은 **scheduler에 queued 작업만 있는 상태**를 뜻합니다. 즉 producer는 `active: 0` 및 실제 `queued` count가 있을 때에만 사용해야 하며, 부모에게 결과를 넘기는 중, foreground/background 전환, detached target, user input/permission 대기, 또는 replay 자체를 뜻하는 표지로 사용해서는 안 됩니다. 실행 중인 작업은 `running`과 `active`로, 실제 종료는 `success`/`error`/`cancelled`과 누적 count로 표현합니다.

`completed`·`failed`·`cancelled`은 generation 안에서 누적 단조 증가시키는 summary입니다. `total`이 `0`이면 progress를 생략합니다. consumer는 count 간 산술 관계와 상세 progress를 추정하지 않습니다. task 제목·설명, prompt, output, cwd, credential, private target ID는 넣지 마세요. label은 형식·길이만 검증·축약되며 의미 기반 redaction은 하지 않습니다.

`attention`은 terminal 관찰용 요약 신호입니다. foreground/background invocation 모두 완료하면 `success`, 실패하면 `error`를 사용하며, consumer는 부모 Pi lifecycle과 이 신호를 병합해 child 완료를 전체 응답 완료로 조기에 표시하지 않습니다. `background` notification policy는 cmux focus나 실제 foreground/background 상태를 판별하지 않습니다. producer의 취소, foreground 전환, parent handoff 또는 ready replay는 attention이 아니며 `attention: "none"`을 사용합니다. 특히 cancellation은 status-only이므로 `all` notification 또는 `attention` flash policy여도 notification·flash·attention log가 되지 않습니다. matching ready에 대한 replay는 새 sequence와 `attention: "none"`으로 현재 summary만 다시 발행합니다.

## exact source의 terminal attention

일반 producer의 attention은 generic 경로로 처리됩니다. 정확히 `source.id: "pi-subagent"`만 consumer의 누적 terminal attention 정책을 사용합니다. 이 정책은 observer의 표시·알림 정책일 뿐 producer lifecycle authority를 바꾸지 않습니다.

1. consumer는 같은 generation의 이전 `completed`·`failed`·`cancelled` baseline과 현재 count의 delta를 비교합니다. success/info는 `completed` 증가, error는 `failed` 증가가 있어야 terminal 후보입니다. `cancelled` 상태와 cancellation delta는 attention을 만들지 않습니다.
2. 첫 update 또는 generation 변경 뒤의 non-`none` attention에는 신뢰할 과거 baseline이 없습니다. 이 경우 count를 과거 완료로 해석하지 않는 unknown live signal만 가능합니다. 어느 누적 count든 감소하면 consumer는 해당 update의 terminal-attention 해석과 쌓인 burst를 fail-closed로 버리고 새 baseline부터 다시 시작합니다. 이미 수락된 status/progress는 새 update로 렌더링되며, 무효 burst가 보류하던 local parent attention은 고정 local fallback으로 복원됩니다.
3. success terminal은 첫 success부터 고정 450ms, error terminal은 첫 error부터 고정 100ms window에서 같은 burst를 모읍니다. 부모 Pi run이 활성이어도 window는 닫히며, 현재 같은 종류 window의 뒤따른 terminal은 deadline을 연장하지 않습니다. success 뒤 최초 error는 자체 고정 100ms window를 시작합니다. window가 닫힌 뒤에도 같은 부모 run·generation에 연결된 terminal은 새 고정 window를 시작할 수 있고, 그 delta는 같은 부모 aggregate에 더해져 settlement에서 notification 한 번으로 확정될 수 있습니다. settlement가 열린 window 안에 도착하면 dispatch는 window 종료까지 보류합니다. 단, 이미 settle된 이전 부모 aggregate가 열린 채 다음 부모 run이 시작되면 lifecycle boundary에서 이전 aggregate를 dispatch해 run 간 결합을 막습니다. 활성 부모에 연결된 error는 window 뒤 settlement를 기다릴 수 있지만 최초 error부터 최대 10초에 한 번 dispatch하며, 뒤늦은 semantic window가 이를 늦추지 않습니다. timeout만 해당 부모 run의 뒤늦은 settlement를 fence해 중복 native attention을 막습니다. 비활성 부모에서 시작된 error는 독립적이므로 100ms 안에 부모가 시작해도 그 부모를 기다리지 않습니다. 같은 aggregate에서는 error가 success보다 우선합니다.
4. 이 semantic terminal coalescing은 Unix socket queue의 latest-write-wins와 다릅니다. queue 방식은 아직 실행하지 않은 같은 UI key의 전송을 최신 요청으로 바꾸는 최적화이고, terminal coalescing은 count delta와 parent lifecycle을 사용해 user-facing alert를 한 번으로 만드는 정책입니다.

성공 child aggregate와 성공 부모가 실제 `agent_settled`에서 관찰되어 함께 확정된 경우에만 title은 정확히 `Pi response ready`입니다. 이 문구는 child 완료만으로 parent 응답이 준비되었다고 주장하지 않으며, settlement 관찰 전에는 사용하지 않습니다. 이 병합 결과는 generic external success가 아니라 finalized local completion으로 판정되어 `settled` policy에서도 notification 대상입니다. host가 `agent_settled` 등록을 지원하지 않을 때만 `agent_end` fallback이 사용됩니다.

그 외 고정 title은 독립 success의 `Subagents completed`, error의 `Subagents need attention`, 활성 부모 error 10초 timeout의 `Subagent failed`입니다. timeout body에는 `Parent is processing results`가 붙고, 일반 body는 `N completed`·`N failed` count summary만 사용합니다. 정확한 표는 [`event-contract.md`](event-contract.md)의 attention 집계 절을 기준으로 합니다.

공식 cmux hook이 우선하면 이 exact source의 버퍼된 success는 native notification/flash로 보내지 않습니다. `PI_CMUX_PRESENCE_LOG=true`이면 안전한 집계 log는 남을 수 있습니다. 집계 error는 해당 policy와 V2 capability가 허용하면 한 번 notification/flash할 수 있습니다. 이 예외는 일반 외부 producer attention이 항상 hook을 통과한다는 이전 해석을 대체합니다.

## notification·flash 선택

정확한 값과 precedence는 [`configuration.md`](configuration.md)를 기준으로 합니다.

- `PI_CMUX_PRESENCE_NOTIFY_POLICY`: `errors` / `background`(기본) / `settled` / `all` / `disabled`
- `PI_CMUX_PRESENCE_FLASH_POLICY`: `errors`(기본) / `attention` / `disabled`
- 레거시 `PI_CMUX_PRESENCE_NOTIFICATIONS=false` 또는 `PI_CMUX_PRESENCE_FLASH=false`는 enum보다 우선하는 강제 disable입니다. 레거시 `true`는 명시 enum을 덮어쓰지 않습니다. 빈 값이나 잘못된 enum은 각각 기본값으로 돌아갑니다.

기본값은 계속 `background`입니다. `settled`를 명시하면 정확히 settle된 local Pi success/error와 external error는 notification 대상이지만 generic external info/success는 대상이 아닙니다. 위의 merged parent/subagent success는 finalized local completion 예외로 허용됩니다. 기본 구성에서는 성공에 notification/flash를 보장하지 않으며 success flash도 기본 비활성입니다. error attention은 허용된 policy와 capability 아래 한 번의 notification 및 한 번의 flash 대상입니다. 모든 출력은 socket 오류·거부·capability 부재 시 best-effort로 유실될 수 있고, producer 실행·결과·취소를 실패시키지 않습니다.

## ready, authority 및 실패 격리

consumer는 session start 뒤 frozen `pi-presence:ready:v1` advertisement로 `cmux-status`, `cmux-progress`, `cmux-attention`, `presence-remove-v1` capability를 광고한 뒤 frozen consumer-less request 하나를 냅니다. 이는 UI hint와 replay/discovery protocol일 뿐 실행 권한을 주지 않습니다. consumer는 자기 request의 exact identity를 무시한다. 외부 matching consumer-less ready는 strict V1 request이므로 활성 consumer는 frozen advertisement 하나로 응답하고 retained local/todo state를 새 sequence와 `attention: "none"`으로 정확히 한 번 replay한다. 반대로 `consumer`가 있는 ready advertisement는 passive capability advertisement일 뿐이며 response나 local/todo replay를 절대 유발하지 않는다. response 중 nested request는 무시하므로 mutating observer도 replay를 증폭할 수 없다. malformed·stale·비활성 session event는 무시한다. matching `sessionId`의 request를 받은 producer는 retained summary를 새 sequence 및 `attention: "none"`으로 replay할 수 있다. transient producer의 `presence-remove-v1` capability 확인은 권장되지만 mandatory gate가 아니다. `pi-subagent`는 이전 consumer 호환성을 위해 capability를 기다리지 않는 ungated update/remove를 의도적으로 발행하며, 이전 consumer는 마지막 update를 session teardown까지 sticky하게 유지한다. `presence-remove-v1`을 확인한 producer가 더 높은 sequence로 exact `pi-subagent` source를 remove하면 consumer는 retained status와 누적 baseline·pending terminal timer·parent association을 무효화한다. 단, child aggregate가 보류 중이던 local parent attention은 조용히 유실하지 않고 기존 fallback policy를 적용한다.

이 연동은 observer-only입니다. `pi-cmux-presence`는 다음을 하지 않으며 producer가 요청해서도 안 됩니다.

- subagent 실행·취소·retry·scheduler/queue·lease·reaper·cleanup을 결정하거나 결과를 반환
- foreground/background 또는 detached target의 소유·전환, focus 추적, parent handoff를 수행
- producer state를 보고 terminal action을 실행·교정하거나 Pi interactive lifecycle/resume 권한을 획득
- task/prompt/raw output/cwd/credential/private target 정보를 event나 cmux output으로 복사

수락 거부, event listener 오류, cmux capability 부재, socket 오류·시간 초과·큐 포화는 presence 출력만 잃게 할 수 있으며 producer lifecycle에는 전파되지 않아야 합니다. generic producer가 직접 cmux를 호출하는 것을 이 계약이 금지하거나 요구하지는 않지만, 이 패키지는 그런 외부 mutation을 조정하거나 live parity를 주장하지 않습니다.

## 확인 범위

이 저장소에서는 다음만 검증합니다.

```bash
bun run ci
```

이는 consumer 쪽 contract parser·source fence·cumulative attention policy·ready replay·rendering과 fake Unix socket 경로의 자동 검증입니다. 정적 fixture는 generic producer wire shape와 status-key namespace만, child-profile test는 검토한 exact suppression 값만 다룹니다. 실행 중인 `pi-subagent` 또는 `pi-cmux`, 두 package의 load order, root aggregate/child `inherit` 공존, cmux 서버와의 live 동작, 외부 producer의 현재 구현, focus 상태 또는 패키지 간 end-to-end parity는 이 저장소에서 검증하거나 주장하지 않습니다.
