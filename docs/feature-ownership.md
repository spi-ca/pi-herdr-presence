# 기능 소유권

| 기능 | pi-herdr-presence | Herdr managed Pi integration | generic producer |
| --- | --- | --- | --- |
| Pi session reference | `herdr:pi` native session report | 설치 시 소유 | 없음 |
| state/metadata/release | `herdr:pi` / `pi` | 설치 시 소유 | state publish만 |
| external presence render | retained update/remove contract | 별도 구현 | state publish |
| agent execution/cancel | 없음 | 없음 | producer 소유 |
| teardown | true title/display/label clear와 15개 metadata token—`active`, `completed`, `failed`, `queued`, `cancelled`, `total`, `progress`, `tokens`, `cost`, `context`, `subagents`, `subagent_wait`, `subagent_error`, `subagent_terminal`, `subagent_terminal_at`—null patch, priority `herdr:pi` release, close를 단일 deadline 안에서 best-effort 수행 | own source | 없음 |

이 extension은 lifecycle authority를 분리하지 않습니다. native session report, state, metadata (`applies_to_source` 포함), clear, release 모두 `source: "herdr:pi"`, `agent: "pi"`입니다.

두 Pi reporter가 같은 pane authority를 경쟁할 수 있으므로 이 package는 managed asset 파일이 있으면 marker 유무와 관계없이 fail-closed 합니다. probe failure도 `unknown`이며, **ENOENT 파일 부재만** local authority를 허용합니다. 이 경우 외에는 local event advertisement/replay, retained session, socket client를 만들지 않습니다.
