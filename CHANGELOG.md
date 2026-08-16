# 변경 이력

## Unreleased

### 신뢰성

- consumer-side `pi-presence:remove:v1`을 추가해 수락된 외부 source의 retained status를 철회하고, 공유 generation/sequence tombstone fence를 유지한 채 progress와 opt-in meta block을 다시 계산합니다. exact `pi-subagent` remove는 pending terminal 집계를 무효화하고 보류된 local parent attention을 고정 fallback으로 복원합니다.
- `settled` notification policy를 추가했습니다. 기본값은 계속 `background`이며, settled는 local success/error와 external error를 허용하고 generic external info/success는 억제합니다. 성공 부모 settlement와 exact `pi-subagent` 성공 집계의 병합은 finalized local completion으로 허용합니다.
- local Pi sidebar/notification을 canonical fixed wording으로 통일하고, terminal sidebar clear와 cmux notification retention의 소유권을 분리했습니다.
- 응답 전 소켓 종료를 즉시 실패로 처리하고, bounded aggregate teardown 안에서 분리 세션 정리 작업을 순차적으로 best-effort 시도합니다.

### 테스트

- remove parser의 strict envelope, update/remove 공유 fence와 tombstone, reserved source, exact status clear, progress/meta 재계산, attention silence, exact `pi-subagent` pending invalidation과 local fallback 복원을 검증합니다.
- `settled` config trim/case, policy matrix·kill switch, canonical local formatter의 static/no-payload byte bound, idle settlement의 exactly-once local notification과 final sidebar clear를 검증합니다.
- 응답 없이 종료되는 소켓과 지연된 다수 status 정리 경로를 검증합니다.
- 검토한 exact child profile, local·`pi-subagent` cancellation의 무attention, active-parent 고정 window·10초 fence, stale official-hook probe, capability 독립성, privacy canary, replacement/shutdown fence 및 notification failure 격리를 fake Unix socket acceptance로 검증합니다.

### 문서

- `pi-presence:remove:v1` payload, shared fence tombstone, ready capability, producer 호환성, 무attention 철회와 event-flow를 문서화합니다.
- settled policy matrix와 merged finalized-local 예외, precedence, focus polling 부재와 cmux의 focused-banner/notification retention 소유권, canonical local wording·privacy boundary를 문서화합니다.
- capability negotiation, 공식 hook 우선순위, usage delta 및 다이어그램·릴리스 이력을 문서화합니다.
- `PI_CMUX_PROFILE=subagent-child-v1`의 exact channel suppression, producer lifecycle 경계, 고정 450ms/100ms terminal window와 제한된 consumer-side static/fake-socket acceptance 범위를 문서화합니다.

## v0.1.0 — 2026-07-25

- 초기 릴리스.
