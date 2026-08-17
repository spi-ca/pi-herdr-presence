import { hasControlOrBidi, isPlainObject } from "./validation.js";
export class PresenceProtocolError extends Error {}
/** Maximum JSON payload size; the transport accounts for the trailing LF separately. */
export const HERDR_MAX_LINE_BYTES = 16 * 1024;
export type HerdrMethod = "pane.report_agent" | "pane.report_agent_session" | "pane.report_metadata" | "pane.release_agent" | "notification.show";
export interface HerdrRequest { id: string; method: HerdrMethod; params: Record<string, unknown>; }
export const LIFECYCLE_SOURCE = "herdr:pi";
const state = new Set(["idle", "working", "blocked", "unknown"]);
const safeText = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf8") <= max && !hasControlOrBidi(v);
const own = (v: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) => Reflect.ownKeys(v).every((k) => typeof k === "string" && allowed.includes(k)) && required.every((k) => Object.hasOwn(v, k));
const sessionRef = (p:Record<string,unknown>) => (safeText(p.agent_session_path,1024) || safeText(p.agent_session_id,128)) && !(p.agent_session_path !== undefined && p.agent_session_id !== undefined);
function valid(request: HerdrRequest): boolean {
 const p = request.params; if (!safeText(request.id, 128) || !safeText(request.method, 64)) return false;
 const base = safeText(p.pane_id, 256) && safeText(p.source, 64);
 switch (request.method) {
 case "pane.report_agent": return base && own(p,["pane_id","source","agent","state","message","seq","agent_session_id","agent_session_path"],["pane_id","source","agent","state","seq"]) && p.source === LIFECYCLE_SOURCE && p.agent === "pi" && state.has(p.state as string) && Number.isSafeInteger(p.seq) && (p.seq as number) >= 0 && (p.message === undefined || p.message === null || safeText(p.message)) && sessionRef(p);
 case "pane.report_agent_session": return base && own(p,["pane_id","source","agent","seq","agent_session_id","agent_session_path","session_start_source"],["pane_id","source","agent","seq"]) && p.source === LIFECYCLE_SOURCE && p.agent === "pi" && Number.isSafeInteger(p.seq) && (p.seq as number) >= 0 && sessionRef(p) && (p.session_start_source === undefined || safeText(p.session_start_source));
 case "pane.report_metadata": {
   const common=base && own(p,["pane_id","source","applies_to_source","agent","seq","title","display_agent","state_labels","clear_title","clear_display_agent","clear_state_labels","tokens"],["pane_id","source","applies_to_source","agent","seq","tokens"]) && p.source === LIFECYCLE_SOURCE && p.applies_to_source === LIFECYCLE_SOURCE && p.agent === "pi" && Number.isSafeInteger(p.seq) && (p.seq as number) >= 0 && isPlainObject(p.tokens) && Object.keys(p.tokens).length <= 16;
   const tokens = p.tokens as Record<string, unknown>;
   const regular=safeText(p.title,128) && safeText(p.display_agent,128) && isPlainObject(p.state_labels) && Object.keys(p.state_labels).length <= 8 && Object.entries(p.state_labels).every(([k,v]) => /^[A-Za-z0-9_-]{1,32}$/.test(k) && safeText(v,128)) && Object.entries(tokens).every(([k,v]) => /^[A-Za-z0-9_-]{1,32}$/.test(k) && (v === null || safeText(v,128)));
   const clearing=p.clear_title === true && p.clear_display_agent === true && p.clear_state_labels === true && p.title === undefined && p.display_agent === undefined && p.state_labels === undefined && Object.entries(tokens).every(([k,v]) => /^[A-Za-z0-9_-]{1,32}$/.test(k) && v === null);
   return common && (regular || clearing);
 }
 case "pane.release_agent": return base && own(p,["pane_id","source","agent","seq"],["pane_id","source","agent","seq"]) && p.source === LIFECYCLE_SOURCE && p.agent === "pi" && Number.isSafeInteger(p.seq) && (p.seq as number) >= 0;
 case "notification.show": return own(p,["title","body","sound"],["title","body","sound"]) && safeText(p.title,128) && safeText(p.body,512) && ["none","done","request"].includes(p.sound as string);
 }
}
export function encodeHerdrRequest(request: HerdrRequest): string { if (!isPlainObject(request.params) || !valid(request)) throw new PresenceProtocolError("Invalid Herdr request."); const line=JSON.stringify(request); if (Buffer.byteLength(line,"utf8") > HERDR_MAX_LINE_BYTES || /[\r\n]/.test(line)) throw new PresenceProtocolError("Herdr request exceeds bound."); return `${line}\n`; }
/** Strict Herdr response envelope: one matching id and either result or a complete error. */
export function decodeHerdrResponse(line: string, id: string): unknown { if (!line || /[\r\n]/.test(line) || Buffer.byteLength(line,"utf8") > HERDR_MAX_LINE_BYTES) throw new PresenceProtocolError("Invalid Herdr response line."); let value: unknown; try { value=JSON.parse(line); } catch { throw new PresenceProtocolError("Invalid Herdr JSON response."); } if (!isPlainObject(value) || value.id !== id) throw new PresenceProtocolError("Invalid Herdr response envelope."); if (own(value,["id","result"],["id","result"])) return value.result; if (own(value,["id","error"],["id","error"]) && isPlainObject(value.error) && own(value.error,["code","message"],["code","message"]) && safeText(value.error.code,128) && safeText(value.error.message,512)) throw new PresenceProtocolError("Herdr remote error."); throw new PresenceProtocolError("Invalid Herdr response envelope."); }
