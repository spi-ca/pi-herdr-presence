import { expect, test } from "bun:test";
import { HERDR_LEGACY_METADATA_TOKEN_KEYS, HERDR_MAX_LINE_BYTES, HERDR_METADATA_TOKEN_KEYS, decodeHerdrResponse, encodeHerdrRequest, isExactAgentAuthorityClearParams, isExactCompanionMetadataClearParams, isExactCompanionMetadataParams, isExactLegacyMetadataClearParams, isExactMetadataClearParams, isExactMetadataIngressParams } from "../src/protocol.js";
const request={id:"a",method:"pane.report_agent" as const,params:{pane_id:"p",source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:"s"}};
const nullMetadataTokens = Object.fromEntries(HERDR_METADATA_TOKEN_KEYS.map(key => [key, null]));
const metadataParams = {pane_id:"p",source:"herdr:pi",applies_to_source:"herdr:pi",agent:"pi",seq:1,title:"Pi",display_agent:"Pi",state_labels:{idle:"Pi is idle",working:"Pi is working",blocked:"Pi needs attention",unknown:"Pi state unknown"},tokens:{...nullMetadataTokens,summary:"idle"}};
const metadataClearParams = {pane_id:"p",source:"herdr:pi",applies_to_source:"herdr:pi",agent:"pi",seq:1,clear_title:true,clear_display_agent:true,clear_state_labels:true,tokens:nullMetadataTokens};
const legacyClearParams = {pane_id:"p",source:"herdr:pi",applies_to_source:"herdr:pi",agent:"pi",seq:1,tokens:Object.fromEntries(HERDR_LEGACY_METADATA_TOKEN_KEYS.map(key => [key, null]))};
const authorityClearParams = {pane_id:"p",source:"herdr:pi",seq:1};
test("strictly encodes known Herdr methods and response envelopes",()=>{
 expect(encodeHerdrRequest(request)).toContain('"pane.report_agent"');
 expect(()=>encodeHerdrRequest({...request,params:{...request.params,state:"done"}})).toThrow();
 expect(encodeHerdrRequest({id:"s",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_id:"session"}})).toContain('"source":"herdr:pi"');
 expect(encodeHerdrRequest({id:"notice",method:"notification.show",params:{title:"Pi",body:"Done",sound:"done"}})).toContain('"notification.show"');
 expect(()=>encodeHerdrRequest({id:"notice",method:"notification.show",params:{title:"Pi",body:"Done",sound:"done",priority:"high"}} as never)).toThrow();
 expect(()=>encodeHerdrRequest({id:"s",method:"pane.report_agent_session",params:{pane_id:"p",source:"other",agent:"pi",seq:1,agent_session_id:"session"}})).toThrow();
 expect(isExactMetadataIngressParams(metadataParams)).toBe(true);
 const companionParams = { pane_id:"p", source:"herdr:pi-presence", applies_to_source:"herdr:pi", seq:1, tokens:{...nullMetadataTokens,summary:"idle"} };
 expect(isExactCompanionMetadataParams(companionParams)).toBe(true);
 expect(encodeHerdrRequest({id:"companion",method:"pane.report_metadata",params:companionParams})).toContain('"herdr:pi-presence"');
 expect(isExactCompanionMetadataParams({...companionParams,agent:"pi"})).toBe(false);
 expect(isExactCompanionMetadataParams({...companionParams,title:"Pi"})).toBe(false);
 expect(isExactCompanionMetadataClearParams({...companionParams,tokens:nullMetadataTokens})).toBe(true);
 expect(encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:metadataParams})).toContain('"v2_progress":null');
 for (const invalid of [
  { ...metadataParams, title: "not Pi" },
  { ...metadataParams, display_agent: "worker-42" },
  { ...metadataParams, state_labels: { ...metadataParams.state_labels, idle: "Waiting on /private/task" } },
  { ...metadataParams, state_labels: { ...metadataParams.state_labels, working: "Subagents are working" } },
  { ...metadataParams, state_labels: { ...metadataParams.state_labels, blocked: "Pi needs your input" } },
  { ...metadataParams, tokens: { ...nullMetadataTokens, v2_progress: "private prompt text" } },
  { ...metadataParams, tokens: { ...nullMetadataTokens, v2_attention: "blocked:worker-secret" } },
 ]) expect(isExactMetadataIngressParams(invalid)).toBe(false);
 expect(isExactMetadataClearParams(metadataClearParams)).toBe(true);
 expect(encodeHerdrRequest({id:"clear",method:"pane.report_metadata",params:metadataClearParams})).toContain('"clear_title":true');
 expect(isExactLegacyMetadataClearParams(legacyClearParams)).toBe(true);
 expect(Object.keys(legacyClearParams.tokens)).toHaveLength(12);
 expect(Object.keys(legacyClearParams.tokens).length).toBeLessThanOrEqual(16);
 expect(encodeHerdrRequest({id:"legacy",method:"pane.report_metadata",params:legacyClearParams})).toContain('"subagent_terminal_at":null');
 expect(isExactLegacyMetadataClearParams({...legacyClearParams,tokens:{...legacyClearParams.tokens,extra:null}})).toBe(false);
 expect(isExactLegacyMetadataClearParams({...legacyClearParams,title:"Pi"})).toBe(false);
 expect(isExactAgentAuthorityClearParams(authorityClearParams)).toBe(true);
 expect(encodeHerdrRequest({id:"authority",method:"pane.clear_agent_authority",params:authorityClearParams})).toContain('"pane.clear_agent_authority"');
 expect(()=>encodeHerdrRequest({id:"authority",method:"pane.clear_agent_authority",params:{...authorityClearParams,source:"other"}})).toThrow();
 expect(()=>encodeHerdrRequest({id:"authority",method:"pane.clear_agent_authority",params:{...authorityClearParams,agent:"pi"}})).toThrow();
 for(const field of ["title","display_agent","state_labels"]) {
  const invalid={...metadataParams,[field]:undefined};
  expect(isExactMetadataIngressParams(invalid)).toBe(false);
  expect(()=>encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:invalid})).toThrow();
 }
 expect(()=>encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:{...metadataParams,seq:undefined}} as never)).toThrow();
 expect(()=>encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:{...metadataParams,tokens:{...nullMetadataTokens,extra:null}}})).toThrow();
 expect(decodeHerdrResponse('{"id":"a","result":{"type":"ok"}}',"a")).toEqual({type:"ok"});
 expect(()=>decodeHerdrResponse('{"id":"a","result":{},"extra":1}',"a")).toThrow();
 expect(()=>decodeHerdrResponse('{"id":"wrong","result":{}}',"a")).toThrow();
});

test("accepts only canonical compact grammars for populated metadata tokens", () => {
 const populated = {
  ...metadataParams,
  tokens: { summary: "input · 3/5 · running 2 · queued 1 · input 1", v2_progress: "3/5", v2_attention: "blocked:new", v2_interaction: "ask_user:1", v2_subagents: "2,0,1,3,4,5,6", v2_terminals: "pi:1:1:completed", v2_terminal_overflow: "0", tokens: "12", cost: "0.25", context: "50" },
 };
 expect(isExactMetadataIngressParams(populated)).toBe(true);
 for (const tokens of [
  { ...populated.tokens, v2_progress: "03/5" },
  { ...populated.tokens, summary: "input · 2/5 · running 2 · queued 1 · input 1" },
  { ...populated.tokens, summary: "input · 3/5 · running 1 · queued 1 · input 1" },
  { ...populated.tokens, summary: "input · 3/5 · running 2 · queued 0 · input 1" },
  { ...populated.tokens, summary: "input · 3/5 · running 2 · queued 1 · input 2" },
  { ...populated.tokens, summary: "blocked · 3/5 · running 2 · queued 1 · input 1" },
  { ...populated.tokens, v2_interaction: null },
  { ...populated.tokens, v2_subagents: null },
  { ...populated.tokens, v2_attention: "blocked:private" },
  { ...populated.tokens, v2_interaction: "ask_user:01" },
  { ...populated.tokens, v2_subagents: "2,0,1,3,4,5" },
  { ...populated.tokens, v2_terminals: "pi:01:1:completed" },
  { ...populated.tokens, v2_terminal_overflow: "01" },
  { ...populated.tokens, tokens: "1.0" },
  { ...populated.tokens, cost: "credential=secret" },
  { ...populated.tokens, context: "1000001" },
  { ...populated.tokens, v2_terminals: null },
 ]) expect(isExactMetadataIngressParams({ ...metadataParams, tokens })).toBe(false);
});

test("uses UTF-8 byte limits for pane and session references, and bounds NDJSON payloads",()=>{
 const pane="😀".repeat(64);
 const sessionId="😀".repeat(32);
 const path=`/${"😀".repeat(255)}abc`;
 expect(Buffer.byteLength(pane,"utf8")).toBe(256);
 expect(Buffer.byteLength(sessionId,"utf8")).toBe(128);
 expect(Buffer.byteLength(path,"utf8")).toBe(1024);
 expect(encodeHerdrRequest({id:"a",method:"pane.report_agent",params:{pane_id:pane,source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:sessionId}})).toContain('"pane_id"');
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_path:path}} as never)).toThrow();
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent",params:{pane_id:"😀".repeat(65),source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:"s"}})).toThrow();
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_id:"😀".repeat(33)}})).toThrow();
 expect(()=>encodeHerdrRequest({id:"a",method:"pane.report_agent_session",params:{pane_id:"p",source:"herdr:pi",agent:"pi",seq:1,agent_session_path:`${path}d`}} as never)).toThrow();
 const prefix='{"id":"a","result":"'; const suffix='"}'; const result="x".repeat(HERDR_MAX_LINE_BYTES-Buffer.byteLength(prefix,"utf8")-Buffer.byteLength(suffix,"utf8"));
 const line=`${prefix}${result}${suffix}`;
 expect(Buffer.byteLength(line,"utf8")).toBe(HERDR_MAX_LINE_BYTES);
 expect(decodeHerdrResponse(line,"a")).toBe(result);
 expect(()=>decodeHerdrResponse(`${line}x`,"a")).toThrow();
});
