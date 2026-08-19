import { expect, test } from "bun:test";
import { encodeTerminalBatch } from "@pi/presence";
import { attentionText, compositeState, metadata, presentation, safeMessage } from "../src/presentation.js";
const epoch="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const interaction={version:2 as const,sessionEpoch:epoch,generation:1,sequence:1,source:"interaction" as const,state:"waiting" as const,interaction:{kind:"ask_user" as const,pending:1},attention:{reason:"input_required" as const,occurrence:"new" as const}};
const aggregate={version:2 as const,sessionEpoch:epoch,generation:1,sequence:1,source:"subagent" as const,state:"running" as const,subagents:{running:2,cancelling:0,queued:1,completed:3,failed:4,cancelled:5,omitted:6}};
const progress={version:2 as const,sessionEpoch:epoch,generation:1,sequence:1,source:"todo" as const,state:"running" as const,progress:{completed:3,total:5}};
const waitingBlocked={version:2 as const,sessionEpoch:epoch,generation:1,sequence:1,source:"pi" as const,state:"waiting" as const,attention:{reason:"blocked" as const,occurrence:"new" as const}};
test("V2 interaction is blocked without producer text",()=>{expect(compositeState([interaction],false)).toBe("blocked");expect(safeMessage("blocked",96,[interaction])).toBe("Pi needs your input");});
test("canonical waiting plus blocked attention retains fixed blocked pane presentation",()=>{expect(compositeState([waitingBlocked],false)).toBe("blocked");expect(safeMessage("blocked",96,[waitingBlocked])).toBe("Pi needs attention");expect(metadata([waitingBlocked]).v2_attention).toBe("blocked:new");});
test("V2 live interaction remains notification eligible",()=>expect(attentionText(interaction,96)).toMatchObject({inputNeeded:true,body:"Pi needs your input"}));
test("presentation keeps display agent and state labels fixed",()=>{expect(presentation()).toEqual({displayAgent:"Pi",labels:{idle:"Pi is idle",working:"Pi is working",blocked:"Pi needs attention",unknown:"Pi state unknown"}});});
test("metadata has ten local keys with a compact complete safe summary",()=>{const tokens=metadata([progress,interaction,aggregate],undefined,{tokens:12,cost:0.25,contextPercent:50});expect(tokens).toEqual({summary:"input · 3/5 · running 2 · queued 1 · input 1",v2_progress:"3/5",v2_attention:"input_required:new",v2_interaction:"ask_user:1",v2_subagents:"2,0,1,3,4,5,6",v2_terminals:null,v2_terminal_overflow:null,tokens:"12",cost:"0.25",context:"50"});});
test("summary keeps every prioritized maximum-counter segment within Herdr's 80-character bound",()=>{const maximum=1_000_000;const tokens=metadata([{...progress,progress:{completed:maximum,total:maximum}},{...interaction,interaction:{kind:"ask_user",pending:maximum}},{...aggregate,subagents:{running:maximum,cancelling:maximum,queued:maximum,completed:maximum,failed:maximum,cancelled:maximum,omitted:maximum}}]);expect(tokens.summary).toBe("input · 1000000/1000000 · running 1000000 · queued 1000000 · input 1000000");expect([...tokens.summary!]).toHaveLength(74);expect(Buffer.byteLength(tokens.summary!,"utf8")).toBeLessThanOrEqual(80);});
test("terminal summary preserves idle or active work and yields to blocked/input/failure",()=>{
 const completed=encodeTerminalBatch([{version:2,sessionEpoch:epoch,generation:1,sequence:1,source:"pi",eventId:1,outcome:"completed"}]);
 const failed=encodeTerminalBatch([{version:2,sessionEpoch:epoch,generation:1,sequence:1,source:"pi",eventId:2,outcome:"failed"}]);
 expect(metadata([],completed,undefined,false,undefined,"completed").summary).toBe("idle · terminal completed");
 expect(metadata([],failed,undefined,true,undefined,"failed").summary).toBe("working · terminal failed");
 expect(metadata([interaction],failed,undefined,false,undefined,"failed").summary).toStartWith("input");
 expect(metadata([waitingBlocked],failed,undefined,false,undefined,"failed").summary).toBe("blocked");
 const failure={...aggregate,state:"error" as const,attention:{reason:"failure" as const,occurrence:"new" as const}};
 expect(metadata([failure],failed,undefined,false,undefined,"failed").summary).toStartWith("blocked");
});
test("terminal summary stays bounded by dropping lower-priority count segments",()=>{
 const maximum=1_000_000;
 const completed=encodeTerminalBatch([{version:2,sessionEpoch:epoch,generation:1,sequence:1,source:"pi",eventId:1,outcome:"cancelled"}]);
 const tokens=metadata([{...progress,progress:{completed:maximum,total:maximum}},{...aggregate,subagents:{running:maximum,cancelling:maximum,queued:maximum,completed:maximum,failed:maximum,cancelled:maximum,omitted:maximum}}],completed,undefined,true,undefined,"cancelled");
 expect(tokens.summary).toBe("working · 1000000/1000000 · running 1000000 · terminal cancelled");
 expect(Buffer.byteLength(tokens.summary!,"utf8")).toBeLessThanOrEqual(80);
});
test("latest terminal arrival is independent of canonical terminal order",()=>{
 const records=[
  {version:2 as const,sessionEpoch:epoch,generation:1,sequence:1,source:"subagent" as const,eventId:1,outcome:"failed" as const},
  {version:2 as const,sessionEpoch:epoch,generation:1,sequence:1,source:"pi" as const,eventId:2,outcome:"completed" as const},
 ];
 const batch=encodeTerminalBatch(records);
 expect(batch.value).toBe("pi:1:2:completed,subagent:1:1:failed");
 expect(batch.records.at(-1)?.outcome).toBe("failed");
 expect(metadata([],batch,undefined,false,undefined,"completed").summary).toBe("idle · terminal completed");
});
test("metadata never exposes epochs or source text",()=>{const result=metadata([aggregate]);expect(JSON.stringify(result)).not.toContain(epoch);});
test("metadata attention priority is deterministic across reverse insertion",()=>{const blocked={...aggregate,source:"pi" as const,state:"waiting" as const,attention:{reason:"blocked" as const,occurrence:"new" as const}};const failure={...aggregate,source:"subagent" as const,state:"error" as const,attention:{reason:"failure" as const,occurrence:"new" as const}};const retainedInput={...interaction,attention:{reason:"input_required" as const,occurrence:"retained" as const}};const liveInput={...interaction,generation:2,attention:{reason:"input_required" as const,occurrence:"new" as const}};for(const events of [[blocked,failure,retainedInput,liveInput],[liveInput,retainedInput,failure,blocked]])expect(metadata(events).v2_attention).toBe("input_required:new");});
test("metadata progress priority is todo then subagent then pi independent of insertion",()=>{const pi={...progress,source:"pi" as const,progress:{completed:1,total:9}};const subagent={...aggregate,progress:{completed:2,total:9}};const todo={...progress,progress:{completed:3,total:9}};for(const events of [[pi,subagent,todo],[todo,subagent,pi]])expect(metadata(events).v2_progress).toBe("3/9");});
