# Generic presence event contract

이 consumer는 process-local `pi-presence:update:v1`, `pi-presence:remove:v1`, `pi-presence:ready:v1`만 소비하며 producer package를 import하지 않습니다.

`update`는 `{ version:1, sessionId, generation, sequence, source:{id,label,kind}, state, counts }`와 선택 `progress`, `usage`, `attention`을 사용합니다. state는 `idle`, `waiting`, `running`, `success`, `error`, `cancelled`, attention은 `none`, `info`, `success`, `error`입니다. text는 control/bidi 없는 1–96 code point, count는 0–1,000,000의 안전한 정수여야 합니다.

consumer는 같은 session ID만 수락합니다. source별 `(generation, sequence)`은 엄격히 증가하고 높은 generation은 **그 source만** reset합니다. 최대 64 source fence/value를 보관합니다. `remove`는 `{version,sessionId,generation,sequence,source:{id}}`이며 update와 같은 fence를 공유합니다. 수락된 remove는 retained value를 없애도 tombstone fence를 유지합니다. unknown source의 remove는 fence slot을 만들지 않습니다. producer는 same-process 협력 component라는 trust boundary 안에 있으며, bounded slot은 accidental/malicious slot 고갈을 완화할 뿐 인증을 제공하지 않습니다.

startup은 advertisement와 consumer-less ready request를 별도 frozen object identity로 emit합니다. own advertisement/request는 exact identity로 무시하고, external consumer-less ready request를 처리하는 동안 reentrancy guard를 유지합니다. 그러므로 synchronous observer가 ready를 재emit해도 advertisement/replay recursion이 생기지 않습니다. matching external request에는 advertisement 하나와 local/todo retained replay 하나를 보냅니다. replay attention은 `none`이며 advertisement는 replay를 만들지 않습니다.

로컬 `pi`와 `pi-todo`는 예약 source입니다. `pi-subagent`를 포함한 external source는 retained composite state와 metadata count에 들어가지만 실행/취소/aggregate authority는 producer에 남습니다. `pi-subagent` terminal은 source generation 변경 또는 count reset에서 pending baseline을 폐기하며, 같은 generation burst의 최초 deadline(성공 450ms, error 100ms)을 연장하지 않습니다. notification dedupe는 source, generation, sequence, local turn transition과 rendered event identity를 포함하므로 새 producer event나 다음 turn은 억제하지 않습니다.
