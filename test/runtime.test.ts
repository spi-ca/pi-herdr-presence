import { expect, test } from "bun:test";
import extension from "../index.js";
import { EVENT_NAMES } from "@pi/presence";
test("extension registers V2 listeners and lifecycle hooks",()=>{const events:string[]=[];const hooks:string[]=[];const old={...process.env};try{Object.assign(process.env,{HERDR_ENV:"1",HERDR_SOCKET_PATH:"/tmp/x",HERDR_PANE_ID:"p"});extension({on:(n:string)=>hooks.push(n),events:{on:(n:string)=>events.push(n),emit(){}}} as never);expect(events).toEqual(expect.arrayContaining([EVENT_NAMES.state,EVENT_NAMES.terminal,EVENT_NAMES.withdraw,EVENT_NAMES.consumerReady]));expect(hooks).toEqual(["agent_settled","session_start","agent_start","turn_start","message_end","agent_end","tool_result","session_shutdown"]);}finally{process.env=old;}});
test("event names use only the current protocol suffix",()=>expect(Object.values(EVENT_NAMES).every(name=>name.endsWith(":v2"))).toBe(true));
test("V2 has terminal channel",()=>expect(EVENT_NAMES.terminal).toBe("pi-presence:terminal:v2"));
test("V2 has consumer readiness channel",()=>expect(EVENT_NAMES.consumerReady).toBe("pi-presence:consumer-ready:v2"));
