# Mermaid 다이어그램

이 디렉터리의 `.mmd` 파일이 다이어그램의 정본입니다. 전역 `mmdc` 설치 없이 다음 명령으로 모든 SVG와 PNG를 재생성합니다.

```bash
bun run diagram:render
```

`diagram:render`는 `docs/diagram/*.mmd`를 모두 순회하며 `bunx @mermaid-js/mermaid-cli`를 실행합니다. `docs/diagram/puppeteer-config.json`(`-p`)과 `docs/diagram/mermaid-config.json`(`-c`)을 공유 설정으로 적용해, 각 SVG는 흰색 배경으로, PNG는 흰색 배경의 2x scale로 렌더링합니다. 정확한 입력·출력 파일과 옵션은 `package.json`의 script를 기준으로 합니다.

## 다이어그램 목록

| 원본 | 렌더 결과 | 설명 |
| --- | --- | --- |
| [`architecture.mmd`](architecture.mmd) | `architecture.svg`, `architecture.png` | Pi lifecycle에서 Unix 소켓 cmux 출력까지의 전체 presence 아키텍처 |
| [`event-flow.mmd`](event-flow.mmd) | `event-flow.svg`, `event-flow.png` | ready capability 광고부터 `pi-presence:update:v1`·`remove:v1` 공유 fence, retained 상태 렌더링·철회, session teardown까지의 이벤트 흐름 |
| [`socket-resolution.mmd`](socket-resolution.mmd) | `socket-resolution.svg`, `socket-resolution.png` | cmux identity(workspace/surface UUID)와 소켓 경로 fingerprint·ancestor 검증, 공식 cmux hook precedence 게이팅 |
| [`protocol-negotiation.mmd`](protocol-negotiation.mmd) | `protocol-negotiation.svg`, `protocol-negotiation.png` | V2 `system.capabilities` probe와 지원 메서드 게이팅, V1 설정 게이팅, best-effort 실패 처리 |
| [`transport-state.mmd`](transport-state.mmd) | `transport-state.svg`, `transport-state.png` | `UnixSocketTransport` 연결 lifecycle과 `BoundedSocketQueue`의 backpressure/coalescing/drop 동작 |
