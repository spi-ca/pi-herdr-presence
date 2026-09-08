import { expect, test } from "bun:test";
import { paneInfo } from "./fixtures/pane-info.js";
import { HERDR_LEGACY_METADATA_TOKEN_KEYS, HERDR_MAX_LINE_BYTES, HERDR_METADATA_TOKEN_KEYS, WORKSPACE_MAIN_SUMMARY_HEARTBEAT_MS, WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS, WORKSPACE_MAIN_SUMMARY_TTL_MS, decodeHerdrResponse, encodeHerdrRequest, isExactAgentAuthorityClearParams, isExactCompanionMetadataClearParams, isExactCompanionMetadataParams, isExactLegacyMetadataClearParams, isExactMetadataClearParams, isExactMetadataIngressParams, isExactWorkspaceMainSummaryParams, isExactWorkspacePaneListResult, isExactWorkspaceReportMetadataResult } from "../src/protocol.js";
const request={id:"a",method:"pane.report_agent" as const,params:{pane_id:"p",source:"herdr:pi",agent:"pi",state:"working",seq:1,agent_session_id:"s"}};
const nullMetadataTokens = Object.fromEntries(HERDR_METADATA_TOKEN_KEYS.map(key => [key, null]));
const metadataParams = {pane_id:"p",source:"herdr:pi",applies_to_source:"herdr:pi",agent:"pi",seq:1,title:"Pi · idle",display_agent:"Pi",state_labels:{idle:"Pi is idle",working:"Pi is working",blocked:"Pi needs attention",unknown:"Pi state unknown"},tokens:{...nullMetadataTokens,summary:"idle"}};
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
 const companionParams = { pane_id:"p", source:"herdr:pi-presence", applies_to_source:"herdr:pi", seq:1, title:"Pi · idle", display_agent:"Pi", state_labels:{idle:"Pi is idle",working:"Pi is working",blocked:"Pi needs attention",unknown:"Pi state unknown"}, tokens:{...nullMetadataTokens,summary:"idle"} };
 const companionClearParams = { pane_id:"p", source:"herdr:pi-presence", applies_to_source:"herdr:pi", seq:1, clear_title:true, clear_display_agent:true, clear_state_labels:true, tokens:nullMetadataTokens };
 expect(isExactCompanionMetadataParams(companionParams)).toBe(true);
 expect(encodeHerdrRequest({id:"companion",method:"pane.report_metadata",params:companionParams})).toContain('"herdr:pi-presence"');
 expect(isExactCompanionMetadataParams({...companionParams,agent:"pi"})).toBe(false);
 expect(isExactCompanionMetadataParams({...companionParams,title:"Pi"})).toBe(false);
 expect(isExactCompanionMetadataParams({...companionParams,display_agent:"worker-42"})).toBe(false);
 expect(isExactCompanionMetadataParams({...companionParams,state_labels:{...companionParams.state_labels,idle:"Waiting on /private/task"}})).toBe(false);
 expect(isExactCompanionMetadataParams({...companionParams,tokens:{...companionParams.tokens,summary:"idle\u0000"}})).toBe(false);
 expect(isExactCompanionMetadataParams({...companionParams,tokens:{...companionParams.tokens,extra:null}})).toBe(false);
 expect(isExactCompanionMetadataClearParams(companionClearParams)).toBe(true);
 expect(isExactCompanionMetadataClearParams({...companionClearParams,clear_title:false})).toBe(false);
 expect(isExactCompanionMetadataClearParams({...companionClearParams,title:"Pi · idle"})).toBe(false);
 expect(encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:metadataParams})).toContain('"v2_progress":null');
 for (const invalid of [
  { ...metadataParams, title: "Pi · working" },
  { ...metadataParams, display_agent: "worker-42" },
  { ...metadataParams, state_labels: { ...metadataParams.state_labels, idle: "Waiting on /private/task" } },
  { ...metadataParams, state_labels: { ...metadataParams.state_labels, working: "Subagents are working" } },
  { ...metadataParams, state_labels: { ...metadataParams.state_labels, blocked: "Pi needs your input" } },
  { ...metadataParams, tokens: { ...metadataParams.tokens, v2_progress: "private prompt text" } },
  { ...metadataParams, tokens: { ...metadataParams.tokens, v2_attention: "blocked:worker-secret" } },
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
  expect(isExactCompanionMetadataParams({...companionParams,[field]:undefined})).toBe(false);
 }
 expect(()=>encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:{...metadataParams,seq:undefined}} as never)).toThrow();
 expect(()=>encodeHerdrRequest({id:"m",method:"pane.report_metadata",params:{...metadataParams,tokens:{...nullMetadataTokens,extra:null}}})).toThrow();
 expect(decodeHerdrResponse('{"id":"a","result":{"type":"ok"}}',"a")).toEqual({type:"ok"});
 expect(()=>decodeHerdrResponse('{"id":"a","result":{},"extra":1}',"a")).toThrow();
 expect(()=>decodeHerdrResponse('{"id":"wrong","result":{}}',"a")).toThrow();
});

test("accepts native input summaries without V2 interaction tokens in standalone and companion envelopes", () => {
 const tokens = { ...nullMetadataTokens, summary: "input" };
 const standalone = { ...metadataParams, title: "Pi · input", tokens };
 const companion = { pane_id:"p", source:"herdr:pi-presence", applies_to_source:"herdr:pi", seq:1, title:"Pi · input", display_agent:"Pi", state_labels:metadataParams.state_labels, tokens };
 expect(isExactMetadataIngressParams(standalone)).toBe(true);
 expect(isExactCompanionMetadataParams(companion)).toBe(true);
 expect(encodeHerdrRequest({ id:"native-input", method:"pane.report_metadata", params:standalone })).toContain('"summary":"input"');
});

test("accepts stopping summaries only when they match a positive cancelling aggregate", () => {
 const tokens = { ...nullMetadataTokens, summary: "working · stopping 2", v2_subagents: "0,2,0,0,0,0,0" };
 const params = { ...metadataParams, title: "Pi · working · stopping 2", tokens };
 expect(isExactMetadataIngressParams(params)).toBe(true);
 expect(isExactMetadataIngressParams({ ...params, title: "Pi · working · stopping 3", tokens: { ...tokens, summary: "working · stopping 3" } })).toBe(false);
 expect(isExactMetadataIngressParams({ ...params, title: "Pi · working · stopping 0", tokens: { ...tokens, summary: "working · stopping 0" } })).toBe(false);
 expect(isExactMetadataIngressParams({ ...params, tokens: { ...tokens, v2_subagents: null } })).toBe(false);
});

test("accepts only canonical compact grammars for populated metadata tokens", () => {
 const populated = {
  ...metadataParams,
  title: "Pi · input · 3/5 · running 2 · queued 1 · input 1",
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
 ]) expect(isExactMetadataIngressParams({ ...populated, title: `Pi · ${tokens.summary}`, tokens })).toBe(false);
});

test("accepts schema-valid empty PaneInfo optional fields while preserving eligibility safety", () => {
 const emptyOptional = paneInfo({
  cwd: "", foreground_cwd: "", label: "", title: "", terminal_title: "", terminal_title_stripped: "", display_agent: "",
  state_labels: { empty: "" }, tokens: { empty: "" },
  agent_session: { source: "", agent: "", kind: "id", value: "" },
 });
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [emptyOptional] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ agent: "", state_labels: { "": "" }, tokens: {} })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ state_labels: {}, tokens: {} })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ title: "\u0000" })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ state_labels: { "\u0000": "" } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ state_labels: { "\u202e": "" } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ state_labels: { ["x".repeat(129)]: "" } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ tokens: { empty: "\u202e" } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ type: "pane_list", panes: [paneInfo({ agent_session: { source: "", agent: "", kind: "path", value: "\u0000" } })] }, "workspace")).toBe(false);
});

test("strictly encodes scoped workspace summary requests and bounded pane-list results", () => {
 const list = { type: "pane_list", panes: [paneInfo()] };
 expect(encodeHerdrRequest({ id: "list", method: "pane.list", params: { workspace_id: "workspace" } })).toContain('"workspace_id":"workspace"');
 expect(() => encodeHerdrRequest({ id: "list", method: "pane.list", params: {} })).toThrow();
 expect(isExactWorkspacePaneListResult(list, "workspace")).toBe(true);
 const { cwd: _cwd, foreground_cwd: _foregroundCwd, label: _label, agent: _agent, title: _title, terminal_title: _terminalTitle, terminal_title_stripped: _terminalTitleStripped, display_agent: _displayAgent, state_labels: _stateLabels, tokens: _tokens, agent_session: _agentSession, scroll: _scroll, ...minimalPane } = paneInfo();
 expect(isExactWorkspacePaneListResult({ ...list, panes: [minimalPane] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ cwd: null, foreground_cwd: null, label: null, agent: null, title: null, terminal_title: null, terminal_title_stripped: null, display_agent: null, agent_session: null, scroll: null })] }, "workspace")).toBe(true);
 // Herdr PaneInfo.agent is optional and nullable; bounded strings, including empty strings, are schema-valid.
 expect(isExactWorkspacePaneListResult({ ...list, panes: [...list.panes, paneInfo({ pane_id: "shell", agent: "shell" }), (() => { const { agent: _agent, ...none } = paneInfo({ pane_id: "none" }); return none; })(), paneInfo({ pane_id: "null", agent: null }), paneInfo({ pane_id: "empty", agent: "" })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ workspace_id: "other" })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), agent: 1 }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), agent: "" }] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_status: "done" })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), focused: "yes" }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), agent_status: "other" }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), revision: -1 }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), revision: Number.MAX_SAFE_INTEGER + 1 }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), terminal_id: "" }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ label: "x".repeat(513) })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ cwd: "x".repeat(4096) })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ cwd: "x".repeat(4097) })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: { source: "pi", agent: "pi", kind: "id", value: "x".repeat(256) } })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: { source: "pi", agent: "pi", kind: "path", value: "x".repeat(4096) } })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: { source: "pi", agent: "pi", kind: "id", value: "x".repeat(257) } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: { source: "pi", agent: "pi", kind: "path", value: "x".repeat(4097) } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: { source: "pi", agent: "pi", kind: "other" as never, value: "session" } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: { source: "pi", agent: "pi", kind: "id", value: "session", extra: true } as never })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ scroll: { offset_from_bottom: 5, max_offset_from_bottom: 1, viewport_rows: 0 } })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ scroll: { offset_from_bottom: -1, max_offset_from_bottom: 0, viewport_rows: 1 } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ scroll: { offset_from_bottom: 0, max_offset_from_bottom: Number.MAX_SAFE_INTEGER + 1, viewport_rows: 1 } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0 } as never })] }, "workspace")).toBe(false);
 const stateLabels32 = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`state${index}`, "Idle"]));
 const tokens32 = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`key${index}`, "idle"]));
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ state_labels: stateLabels32, tokens: tokens32 })] }, "workspace")).toBe(true);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ tokens: { "invalid.key": "idle" } })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ tokens: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key${index}`, "idle"])) })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ state_labels: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`state${index}`, "Idle"])) })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), extra: null }] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: [{ ...paneInfo(), [Symbol("extra")]: null }] }, "workspace")).toBe(false);
 let accessorReads = 0;
 const accessorPane = paneInfo();
 Object.defineProperty(accessorPane, "agent", { enumerable: true, get() { accessorReads += 1; return "pi"; } });
 expect(isExactWorkspacePaneListResult({ ...list, panes: [accessorPane] }, "workspace")).toBe(false);
 expect(accessorReads).toBe(0);
 const accessorTokens = { summary: "idle" };
 Object.defineProperty(accessorTokens, "summary", { enumerable: true, get() { accessorReads += 1; return "idle"; } });
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ tokens: accessorTokens })] }, "workspace")).toBe(false);
 expect(accessorReads).toBe(0);
 const prototypePane = paneInfo();
 Object.setPrototypeOf(prototypePane, { inherited: true });
 expect(isExactWorkspacePaneListResult({ ...list, panes: [prototypePane] }, "workspace")).toBe(false);
 const prototypeSession = { source: "pi", agent: "pi", kind: "id" as const, value: "session" };
 Object.setPrototypeOf(prototypeSession, { inherited: true });
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: prototypeSession })] }, "workspace")).toBe(false);
 const accessorSession = { source: "pi", agent: "pi", kind: "id" as const, value: "session" };
 Object.defineProperty(accessorSession, "value", { enumerable: true, get() { accessorReads += 1; return "session"; } });
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: accessorSession })] }, "workspace")).toBe(false);
 expect(accessorReads).toBe(0);
 const symbolSession = { source: "pi", agent: "pi", kind: "id" as const, value: "session" };
 Object.defineProperty(symbolSession, Symbol("extra"), { enumerable: true, value: true });
 expect(isExactWorkspacePaneListResult({ ...list, panes: [paneInfo({ agent_session: symbolSession })] }, "workspace")).toBe(false);
 expect(isExactWorkspacePaneListResult({ ...list, panes: Array.from({ length: 129 }, (_, index) => paneInfo({ pane_id: String(index), agent: "other" })) }, "workspace")).toBe(false);
 const sparse = new Array(1);
 expect(isExactWorkspacePaneListResult({ ...list, panes: sparse }, "workspace")).toBe(false);
 const extended = [paneInfo()];
 Object.assign(extended, { extra: true });
 expect(isExactWorkspacePaneListResult({ ...list, panes: extended }, "workspace")).toBe(false);
 const customPrototype = [paneInfo()];
 Object.setPrototypeOf(customPrototype, {});
 expect(isExactWorkspacePaneListResult({ ...list, panes: customPrototype }, "workspace")).toBe(false);
 expect(WORKSPACE_MAIN_SUMMARY_TTL_MS).toBe(30_000);
 expect(WORKSPACE_MAIN_SUMMARY_HEARTBEAT_MS).toBe(10_000);
 expect(WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS).toBe(5_000);
 const workspace = { workspace_id: "workspace", source: "herdr:pi-presence", seq: 1, ttl_ms: WORKSPACE_MAIN_SUMMARY_TTL_MS, tokens: { main_summary: "working · 1/2" } };
 expect(isExactWorkspaceMainSummaryParams(workspace)).toBe(true);
 expect(isExactWorkspaceReportMetadataResult({ type: "ok" })).toBe(true);
 expect(isExactWorkspaceReportMetadataResult({})).toBe(false);
 expect(isExactWorkspaceReportMetadataResult({ type: "ok", extra: true })).toBe(false);
 expect(encodeHerdrRequest({ id: "workspace", method: "workspace.report_metadata", params: workspace })).toContain('"main_summary":"working · 1/2"');
 expect(isExactWorkspaceMainSummaryParams({ ...workspace, tokens: { main_summary: "private prompt" } })).toBe(false);
 expect(isExactWorkspaceMainSummaryParams({ ...workspace, ttl_ms: WORKSPACE_MAIN_SUMMARY_TTL_MS + 1 })).toBe(false);
 expect(isExactWorkspaceMainSummaryParams({ ...workspace, tokens: { main_summary: "idle", extra: "no" } })).toBe(false);
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
