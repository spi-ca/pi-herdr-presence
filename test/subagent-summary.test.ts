import { expect, test } from "bun:test";
import { encodeTerminalBatch, parseTerminalBatch } from "@pi/presence";
const epoch="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const terminal=(eventId:number,outcome:"completed"|"failed"|"cancelled"="completed")=>({version:2 as const,sessionEpoch:epoch,generation:1,sequence:eventId,source:"subagent" as const,eventId,outcome});
test("terminal batch is canonical",()=>expect(encodeTerminalBatch([terminal(2,"failed"),{...terminal(1),source:"pi" as const}],0).value).toBe("pi:1:1:completed,subagent:1:2:failed"));
test("terminal batch is bounded to three records",()=>expect(()=>encodeTerminalBatch([terminal(1),terminal(2),terminal(3),terminal(4)])).toThrow());
test("terminal batch retains bounded overflow",()=>expect(encodeTerminalBatch([terminal(1)],7).overflow).toBe(7));
test("terminal parsing rejects noncanonical text",()=>expect(parseTerminalBatch("subagent:1:2:failed,pi:1:1:completed")).toBeUndefined());
