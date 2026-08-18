import { expect, test } from "bun:test";
import { EVENT_NAMES, createPresenceConsumer, parsePresenceStateInputV2, parsePresenceStateV2, parsePresenceTerminalV2, parsePresenceWithdrawV2 } from "@pi/presence";
const epoch="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
test("V2 event names are fixed",()=>expect(Object.values(EVENT_NAMES)).toEqual(["pi-presence:state:v2","pi-presence:terminal:v2","pi-presence:withdraw:v2","pi-presence:consumer-ready:v2"]));
test("V2 state accepts only canonical source state",()=>expect(parsePresenceStateV2({version:2,sessionEpoch:epoch,generation:0,sequence:0,source:"pi",state:"running"})).toBeDefined());
test("V2 producer inputs never carry a consumer epoch",()=>expect(parsePresenceStateInputV2({version:2,sessionEpoch:epoch,generation:0,sequence:0,source:"pi",state:"running"})).toBeUndefined());
test("V2 terminal and withdraw are strict",()=>{expect(parsePresenceTerminalV2({version:2,sessionEpoch:epoch,generation:0,sequence:1,source:"subagent",eventId:0,outcome:"failed"})).toBeDefined();expect(parsePresenceWithdrawV2({version:2,sessionEpoch:epoch,generation:0,sequence:2,source:"subagent"})).toBeDefined();});
test("forged direct DTOs have no registry delivery receipt",()=>{const consumer=createPresenceConsumer({id:"pi-herdr-presence"})!;expect(consumer.accept(EVENT_NAMES.state,{version:2,sessionEpoch:epoch,generation:0,sequence:0,source:"pi",state:"running"})).toBeUndefined();});
