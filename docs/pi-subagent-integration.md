# Shared producer integration

`pi-herdr-presence` neither imports nor controls `pi-subagent`. It is a consumer of accepted shared `@pi/presence` V2 state, terminal, and withdraw events, then projects only the bounded fixed Herdr metadata described in the [event contract](event-contract.md).

Producer ownership, lifecycle, receipts, generation/sequence fences, withdrawal, and terminal encoding are defined by the pinned [V2 API](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/docs/api.md), [lifecycle guide](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/README.md), and [terminal fixture](https://github.com/spi-ca/pi-presence/blob/v2-20260818-2/fixtures/normative.json).

No task/subagent argument, prompt, output, task/subagent content identifier, session name/path, or raw error is retained or projected. Required opaque pane/workspace IDs, the standalone session ID, and sequence, protocol, and terminal ordinals plus derived counts/tokens serve local or wire-state roles and are distinct from arbitrary task/subagent content. A live failed V2 terminal can yield one policy-gated fixed notification under default `errors`; completed and cancelled terminals are quiet by default. The transient summary follows the latest accepted terminal arrival while `v2_terminals` remains canonically encoded.

For mode and cleanup ownership, see [feature ownership](feature-ownership.md). For the end-to-end component flow, see [architecture](architecture.md).
