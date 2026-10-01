# Resume argv 안전성 설계

유지보수자를 위한 **설계 기록이며 구현·릴리스 선언이 아니다**. 현재 기본값은 standalone의 native session ID 보고만 유지하고 `resume_argv`를 보내지 않는 것이다. Companion에서는 이 확장의 session/state 및 resume 보고를 비활성 상태로 유지하고, managed integration이 lifecycle authority를 단독 소유한다. 기존 [설정](configuration.md#managed-marker-and-mode-selection)과 [소유권·개인정보 경계](feature-ownership.md)를 변경하지 않는다.

## 확인한 Herdr 동작과 버전

아래 소스 링크는 Herdr `v0.9.3`의 commit `7b116c05bfda646af39d2524c54e70c751f57ee8`에 고정했다. API 존재 확인과 실행 중인 서버의 지원 여부·실제 복원 성공은 별개다.

- [Schema][schema]에는 `pane.report_agent`와 `pane.report_agent_session`의 선택적 `resume_argv`가 이미 있다. [API 처리][api-report]는 argv를 검증하고, 함께 전달된 session 보고가 적용되었는지 및 reporter의 pane 소유권을 확인한다.
- [Native Pi planner][native]는 `source: "herdr:pi"`, `agent: "pi"`의 ID **또는** path 참조를 `['pi', '--session', id_or_path]`로 복원한다. 따라서 **argv 생략은 resume 비활성화가 아니다**. Herdr의 `[session] resume_agents_on_restore = false`가 복원 실행을 끄는 설정이다.
- [Restore 선택][restore]은 저장된 custom argv를 native session plan보다 우선한다. 새 보고에서 argv를 생략해도 기존 custom argv를 지우지 않는다([API의 `None` 처리][api-report]).
- 고정된 [v0.9.2 변경 기록][changelog]은 이미 self-reported resume command 추가를 명시한다([릴리스 안내][release]는 보조 링크). 반면 같은 `v0.9.3` 트리의 [docs/next 안내][next]는 최소 `0.10.0`이라고 적어 소스·릴리스와 충돌한다. 이 설계는 그 안내를 최소 버전 근거로 쓰지 않으며 새 릴리스를 주장하지 않는다.

## 기본값과 개인정보 제한

현재 [ID-only `SessionRef`와 companion 차단](../src/client.ts)은 유지한다. Standalone의 session 참조는 opaque `agent_session_id`만 보고하며 `agent_session_path`, cwd, 환경 변수, 원본 CLI 인자·명령줄을 resume 재현 목적으로 수집하거나 resume payload로 보내지 않는다. 범용 argv 캡처, 실행 파일 경로 추정, shell/CLI/child-process 실행도 추가하지 않는다. Companion의 metadata와 기존 in-process blocked lease는 이 resume 결정과 별개로 유지된다.

ID-only는 경로 노출을 줄이지만 저장소 독립적인 복원을 보장하지 않는다. Pi `0.99.2`의 `resolveSessionPath`는 현재 프로젝트/session directory와 접근 가능한 전체 session 저장소에서 ID를 찾는다. 기본 저장소 밖의 `--session-dir`, 바뀐 agent directory/HOME, 이동·삭제된 파일 또는 다른 머신의 저장소는 같은 ID만으로 복구되지 않을 수 있다. 원래 환경·인자를 재현하지 않으므로 모델·provider·확장 설정까지 같은 실행이라는 보장도 없다. 이 제약을 자동 경로/환경 캡처로 보완하지 않는다.

이 기본값은 **새 custom argv를 기록하지 않는 정책**이지, Herdr가 이미 저장한 argv를 제거하거나 managed reporter를 제어하는 정책이 아니다. 기존 값의 제거는 서버 측 mutation 증거가 필요하다.

## Custom argv를 지금 추가하지 않는 이유

### Native/custom 중복 제거가 동등하지 않음

[Native dedupe key][native-key]는 `(source, agent, session_ref.kind, session_ref.value)`이고, [custom key][custom-key]는 `(source, agent, cwd, argv)`다. 동일 session을 native로 기록한 pane과 `['pi', '--session', id]`를 custom으로 기록한 pane은 다른 key가 된다. [Restore][restore]의 key 집합만으로 혼합 중복 실행을 막을 수 없고, cwd/옵션 차이도 custom key를 바꾼다. Native와 같은 명령을 보낸다는 사실만으로 중복 제거가 동등해지지 않는다.

### Session 교체와 argv 제거가 원자적이지 않음

[저장된 argv][resume-state]는 source/agent/argv에 묶이며 session ID 자체에 묶이지 않는다. [새 session 보고][session-state]가 같은 source/agent의 참조를 교체해도 이전 argv를 자동 제거하지 않으며, `reconcile_reported_resume`도 다른 source/agent 소유권을 기준으로 제거한다.

따라서 `A의 argv 저장 → authority clear 실패 또는 무효 → B session 보고 적용(argv 없음) → B state/argv 보고 실패`이면 **B의 session 참조와 A의 argv가 함께 남을 수 있다**. Restore는 custom 우선이므로 A를 다시 실행할 위험이 있다. 로컬 epoch/queue fencing은 서버에 이미 남은 A를 제거하지 못한다.

[Authority clear mutation][clear-state]은 일치하는 현재 hook authority와 수락 가능한 source/seq가 있어야 발생한다. Authority가 없거나 다른 source이거나 seq가 오래되면 mutation 없이 반환할 수 있다. 그런데 [clear API][clear-api]는 일반 `ok`를 반환하므로 acknowledgement만으로 persisted session/argv 제거를 증명할 수 없다. 단순한 clear 후 재보고 또는 재시도만으로 원자적 교체를 주장하지 않는다.

### Subprocess의 pane 소유권은 독립 증명이 필요함

Managed-marker probe와 현재 in-process coordinator는 다른 프로세스의 reporter를 통제하지 않는다. 부모와 Herdr identity를 공유하는 subprocess가 managed integration을 독립 로드할 수 있으므로, 이 확장만의 신규 guard로 pane authority/resume 안전성을 보장할 수 없다. 이번 변경에는 subprocess guard도 구현하지 않는다.

## 재검토 승인 조건

Custom argv는 아래 조건을 **모두** 증명하는 별도 구현 PR까지 보류한다.

1. **Dedupe 동등성:** native/custom 및 서로 다른 cwd/옵션의 동일 session을 한 번만 복원하는 서버 계약과 회귀 테스트. ID/path가 같은 session을 가리키는 경우도 검토한다.
2. **원자적 교체·제거:** session identity와 argv를 함께 replace/remove하는 서버 계약 또는 동등한 증거. A→B, clear 무효·실패, session만 성공, state/argv 실패, 응답 유실, stale seq를 포함해 이전 argv가 새 session에 붙지 않음을 확인한다. 일반 `ok`만을 mutation 증거로 쓰지 않는다.
3. **Subprocess 소유권:** 부모 pane identity를 물려받은 자식과 managed integration의 독립 reporter까지 포함하는 소유권 계약. Subprocess 환경 marker가 정상·누락·부분 존재·빈 값·비정상 값인 경우에도 fail-closed이며, marker 부재나 이 확장 비활성화만으로 managed reporter 부재를 추정하지 않는다.
4. **개인정보·검증:** 허용할 값은 고정 명령과 검증된 opaque ID로 최소화하고, paths/env/범용 CLI 캡처는 계속 금지한다. Herdr argv 형식 검증을 통과하는 것과 위 안전 조건의 충족을 구분한다.

## 이번 검증 범위

고정된 upstream 소스·릴리스와 로컬 보고 계약을 읽고 문서 링크·탐색·diff를 검증한 문서 전용 변경이다. Live restore 및 실행 중인 서버의 capability는 테스트하지 않았고, 서버 재시작·managed asset 수정·설치 변경도 하지 않았다. 실제 interoperability나 독립 managed reporter 통제를 검증했다고 해석하면 안 된다.

[native]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/agent_resume.rs#L234-L236
[native-key]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/agent_resume.rs#L314-L326
[custom-key]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/agent_resume.rs#L30-L54
[restore]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/persist/restore.rs#L808-L845
[session-state]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/terminal/state.rs#L1639-L1679
[resume-state]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/terminal/state.rs#L1931-L2029
[clear-state]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/terminal/state.rs#L1762-L1808
[api-report]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/panes.rs#L1592-L1691
[clear-api]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/app/api/panes.rs#L1866-L1880
[schema]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/src/api/schema/panes.rs#L356-L398
[changelog]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/CHANGELOG.md#L13-L19
[release]: https://github.com/herdrdev/herdr/releases/tag/v0.9.2
[next]: https://github.com/herdrdev/herdr/blob/7b116c05bfda646af39d2524c54e70c751f57ee8/docs/next/website/src/content/docs/add-herdr-support.mdx#L89-L97
