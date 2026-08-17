import { expect, test } from "bun:test";
import { HERDR_MAX_LINE_BYTES, decodeHerdrResponse, encodeHerdrRequest } from "../src/protocol.js";
const request={id:"a",method:"pane.report_agent" as const,params:{pane_id:"p",source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:"s"}};
test("strictly encodes known Herdr methods and response envelopes",()=>{
 expect(encodeHerdrRequest(request)).toContain('"pane.report_agent"');
 expect(()=>encodeHerdrRequest({...request,params:{...request.params,state:"done"}})).toThrow();
 expect(encodeHerdrRequest({id:"s",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_id:"session"}})).toContain('"source":"herdr:pi"');
 expect(()=>encodeHerdrRequest({id:"notice",method:"notification.show",params:{title:"Pi",body:"Done",sound:"done",priority:"high"}} as never)).toThrow();
 expect(()=>encodeHerdrRequest({id:"s",method:"pane.report_agent_session",params:{pane_id:"p",source:"other",agent:"pi",seq:1,agent_session_id:"session"}})).toThrow();
 expect(encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:{pane_id:"p",source:"herdr:pi",applies_to_source:"herdr:pi",agent:"pi",seq:1,clear_title:true,clear_display_agent:true,clear_state_labels:true,tokens:{active:null}}})).toContain('"clear_title":true');
 expect(decodeHerdrResponse('{"id":"a","result":{"type":"ok"}}',"a")).toEqual({type:"ok"});
 expect(()=>decodeHerdrResponse('{"id":"a","result":{},"extra":1}',"a")).toThrow();
 expect(()=>decodeHerdrResponse('{"id":"wrong","result":{}}',"a")).toThrow();
});

test("uses UTF-8 byte limits for pane and session references, and bounds NDJSON payloads",()=>{
 const pane="😀".repeat(64);
 const sessionId="😀".repeat(32);
 const path=`/${"😀".repeat(255)}abc`;
 expect(Buffer.byteLength(pane,"utf8")).toBe(256);
 expect(Buffer.byteLength(sessionId,"utf8")).toBe(128);
 expect(Buffer.byteLength(path,"utf8")).toBe(1024);
 expect(encodeHerdrRequest({id:"a",method:"pane.report_agent",params:{pane_id:pane,source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:sessionId}})).toContain('"pane_id"');
 expect(encodeHerdrRequest({id:"a",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_path:path}})).toContain('"agent_session_path"');
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent",params:{pane_id:"😀".repeat(65),source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:"s"}})).toThrow();
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_id:"😀".repeat(33)}})).toThrow();
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_path:`${path}d`}})).toThrow();
 const prefix='{"id":"a","result":"'; const suffix='"}'; const result="x".repeat(HERDR_MAX_LINE_BYTES-Buffer.byteLength(prefix,"utf8")-Buffer.byteLength(suffix,"utf8"));
 const line=`${prefix}${result}${suffix}`;
 expect(Buffer.byteLength(line,"utf8")).toBe(HERDR_MAX_LINE_BYTES);
 expect(decodeHerdrResponse(line,"a")).toBe(result);
 expect(()=>decodeHerdrResponse(`${line}x`,"a")).toThrow();
});
