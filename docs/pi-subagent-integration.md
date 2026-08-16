# pi-subagent generic producer integration

`pi-herdr-presence`는 `pi-subagent`를 dependency로 import하거나 실행/취소 authority를 갖지 않습니다. 같은 Pi process event bus에 [generic event contract](event-contract.md)를 발행하는 경우에만 정확한 `source.id: "pi-subagent"`를 cumulative terminal producer로 처리합니다.

consumer는 producer의 generation/sequence fence를 따릅니다. generation 변경, remove 또는 cumulative count 감소는 retained baseline과 pending terminal aggregate를 폐기합니다. 같은 generation의 terminal burst는 최초 event 기준 success 450ms/error 100ms deadline을 사용하며 뒤 event가 deadline을 sliding시키지 않습니다. producer payload의 label, task text, prompt, tool output은 Herdr notification text로 복사되지 않습니다.
