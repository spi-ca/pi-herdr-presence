# 변경 이력

## Unreleased

- 기존 baseline을 `pi-herdr-presence`로 교체했습니다.
- Herdr TUI 환경의 request-per-connection socket API와 `pane.report_agent`, session, metadata, notification 출력을 구현했습니다.
- generic update/remove/ready contract, source generation/sequence tombstone, replay와 Pi lifecycle composite rendering을 유지했습니다.
- Herdr-managed Pi integration과의 authority 충돌을 fail-closed로 방지했습니다.

## v0.1.0

- 초기 Herdr 전용 릴리스.
