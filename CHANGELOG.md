# 변경 이력

## Unreleased

- retained `interaction`/`waiting` presence는 attention과 관계없이 static input-needed blocked presentation으로 렌더하고, 각 open lifecycle의 첫 effective live `info`만 `request` notification sound로 알립니다. silent replay 자체와 알림 전달 뒤 native/generic 중복은 재알림하지 않으며 producer text를 전달하지 않습니다.
- `pi-presence:summary:v1` companion strict parser와 bounded subagent metadata token을 추가했습니다. terminal은 configured final clear 기간만 보존하며 raw task/output/error/path/socket/target 정보를 전달하지 않습니다.
- severity 기반 TTL/LRU(64) notification dedupe, blocked/ask-user transition 알림, unref long-running timer를 추가했습니다. Herdr에는 allowlist된 `sound`만 보냅니다.
- command, skill, prompt, LLM-callable tool을 등록하지 않아 모델의 기본 context를 확장하지 않습니다.
- managed 경로의 exact tilde 확장과 fail-closed canonical 검증, lexical/resolved socket ancestor 검증, UTF-8 byte-safe best-effort encoding, 단일 deadline teardown abort, summary remove tombstone 및 bounded terminal/dedupe identity로 lifecycle·보안 경계를 강화했습니다.
- 기존 baseline을 `pi-herdr-presence`로 교체했습니다.
- Herdr TUI 환경의 request-per-connection socket API와 `pane.report_agent`, session, metadata, notification 출력을 구현했습니다.
- generic update/remove/ready contract, source generation/sequence tombstone, replay와 Pi lifecycle composite rendering을 유지했습니다.
- Herdr-managed Pi integration과의 authority 충돌을 fail-closed로 방지했습니다.

## v0.1.0

- 초기 Herdr 전용 릴리스.
