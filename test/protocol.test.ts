import { expect, test } from "bun:test";
import { decodeHerdrResponse, encodeHerdrRequest } from "../src/protocol.js";
const request={id:"a",method:"pane.report_agent" as const,params:{pane_id:"p",source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:"s"}};
test("strictly encodes known Herdr methods and response envelopes",()=>{
 expect(encodeHerdrRequest(request)).toContain('"pane.report_agent"');
 expect(()=>encodeHerdrRequest({...request,params:{...request.params,state:"done"}})).toThrow();
 expect(encodeHerdrRequest({id:"s",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_id:"session"}})).toContain('"source":"herdr:pi"');
 expect(()=>encodeHerdrRequest({id:"s",method:"pane.report_agent_session",params:{pane_id:"p",source:"other",agent:"pi",seq:1,agent_session_id:"session"}})).toThrow();
 expect(encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:{pane_id:"p",source:"herdr:pi",applies_to_source:"herdr:pi",agent:"pi",seq:1,clear_title:true,clear_display_agent:true,clear_state_labels:true,tokens:{active:null}}})).toContain('"clear_title":true');
 expect(decodeHerdrResponse('{"id":"a","result":{"type":"ok"}}',"a")).toEqual({type:"ok"});
 expect(()=>decodeHerdrResponse('{"id":"a","result":{},"extra":1}',"a")).toThrow();
 expect(()=>decodeHerdrResponse('{"id":"wrong","result":{}}',"a")).toThrow();
});
