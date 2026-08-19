import { ATTENTION_REASONS, MAX_INTEGER, parseTerminalBatch } from "@pi/presence";
import { hasControlOrBidi, isPlainObject } from "./validation.js";
export class PresenceProtocolError extends Error {}
/** Maximum JSON payload size; the transport accounts for the trailing LF separately. */
export const HERDR_MAX_LINE_BYTES = 16 * 1024;
export type HerdrMethod = "pane.report_agent" | "pane.report_agent_session" | "pane.report_metadata" | "pane.clear_agent_authority" | "notification.show";
export interface HerdrRequest { id: string; method: HerdrMethod; params: Record<string, unknown>; }
export const LIFECYCLE_SOURCE = "herdr:pi";
/** Companion metadata is separately owned but is rendered against managed Pi authority. */
export const COMPANION_METADATA_SOURCE = "herdr:pi-presence";
const state = new Set(["idle", "working", "blocked", "unknown"]);
/** Herdr V2 ingress accepts this complete, token-only metadata patch. */
export const HERDR_METADATA_TOKEN_KEYS = ["summary", "v2_progress", "v2_attention", "v2_interaction", "v2_subagents", "v2_terminals", "v2_terminal_overflow", "tokens", "cost", "context"] as const;
/** One bounded migration patch for metadata owned by the pre-V2 extension. */
export const HERDR_LEGACY_METADATA_TOKEN_KEYS = ["active", "completed", "failed", "queued", "cancelled", "total", "progress", "subagents", "subagent_wait", "subagent_error", "subagent_terminal", "subagent_terminal_at"] as const;
export type HerdrMetadataTokens = Record<(typeof HERDR_METADATA_TOKEN_KEYS)[number], string | null>;
export type HerdrLegacyMetadataTokens = Record<(typeof HERDR_LEGACY_METADATA_TOKEN_KEYS)[number], null>;
export type HerdrPresentation = { displayAgent: string; labels: Record<"idle" | "working" | "blocked" | "unknown", string> };
/** Standalone title is derived only from the validated, bounded summary token. */
export const titleForSummary = (summary: string | null): string => `Pi · ${summary ?? ""}`;
/** Display agent and state labels are fixed; no runtime context reaches them. */
export const HERDR_FIXED_PRESENTATION: HerdrPresentation = Object.freeze({
 displayAgent: "Pi",
 labels: Object.freeze({ idle: "Pi is idle", working: "Pi is working", blocked: "Pi needs attention", unknown: "Pi state unknown" }),
});
const METADATA_PARAM_KEYS = ["pane_id", "source", "applies_to_source", "agent", "seq", "title", "display_agent", "state_labels", "tokens"] as const;
const COMPANION_METADATA_PARAM_KEYS = ["pane_id", "source", "applies_to_source", "seq", "tokens"] as const;
const METADATA_CLEAR_PARAM_KEYS = ["pane_id", "source", "applies_to_source", "agent", "seq", "clear_title", "clear_display_agent", "clear_state_labels", "tokens"] as const;
const METADATA_LEGACY_CLEAR_PARAM_KEYS = ["pane_id", "source", "applies_to_source", "agent", "seq", "tokens"] as const;
const AGENT_AUTHORITY_CLEAR_PARAM_KEYS = ["pane_id", "source", "seq"] as const;
const exactTokens = (tokens: Record<string, unknown>, keys: readonly string[]) => Object.keys(tokens).length === keys.length && keys.every(key => Object.hasOwn(tokens, key));
const exactOwnedTokens = (tokens: Record<string, unknown>) => exactTokens(tokens, HERDR_METADATA_TOKEN_KEYS);
const safeText = (v: unknown, max = 512): v is string => typeof v === "string" && v.length > 0 && Buffer.byteLength(v, "utf8") <= max && !hasControlOrBidi(v);
const own = (v: Record<string, unknown>, allowed: readonly string[], required: readonly string[]) => Reflect.ownKeys(v).every((k) => typeof k === "string" && allowed.includes(k)) && required.every((k) => Object.hasOwn(v, k));
/** Parses only the compact values introduced by this fixed Herdr projection. */
const canonicalInteger = (value: unknown, minimum = 0): value is string => {
 if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,6})$/.test(value)) return false;
 const parsed = Number(value);
 return parsed >= minimum && parsed <= MAX_INTEGER && String(parsed) === value;
};
const canonicalDecimal = (value: unknown): value is string => {
 if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(value) || (value.includes(".") && value.endsWith("0"))) return false;
 const parsed = Number(value);
 return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_INTEGER;
};
const canonicalProgress = (value: unknown): value is string => {
 if (typeof value !== "string") return false;
 const parts = value.split("/");
 return parts.length === 2 && canonicalInteger(parts[0]) && canonicalInteger(parts[1], 1) && Number(parts[0]) <= Number(parts[1]);
};
const canonicalAttention = (value: unknown): value is string => typeof value === "string" && ATTENTION_REASONS.some(reason => value === `${reason}:new` || value === `${reason}:retained`);
const canonicalInteraction = (value: unknown): value is string => typeof value === "string" && value.startsWith("ask_user:") && canonicalInteger(value.slice("ask_user:".length));
const canonicalSubagents = (value: unknown): value is string => typeof value === "string" && value.split(",").length === 7 && value.split(",").every(part => canonicalInteger(part));
/** Standalone pane chrome accepts fixed display fields and a summary-derived title. */
const exactPresentation = (value: unknown): value is Record<string, unknown> => isPlainObject(value)
 && own(value, ["idle", "working", "blocked", "unknown"], ["idle", "working", "blocked", "unknown"])
 && value.idle === HERDR_FIXED_PRESENTATION.labels.idle
 && value.working === HERDR_FIXED_PRESENTATION.labels.working
 && value.blocked === HERDR_FIXED_PRESENTATION.labels.blocked
 && value.unknown === HERDR_FIXED_PRESENTATION.labels.unknown;
type SummaryParts = { state: string; progress?: string; running?: string; queued?: string; pending?: string; terminal?: "completed" | "cancelled" | "failed" };
/** Parse the fixed-order summary grammar so its derived fields can be checked against their source tokens. */
const parseSummary = (value: unknown): SummaryParts | undefined => {
 if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > 80) return undefined;
 const parts = value.split(" · ");
 const statePart = parts.shift();
 if (!statePart || !["idle", "working", "blocked", "input", "unknown"].includes(statePart)) return undefined;
 const result: SummaryParts = { state: statePart };
 if (parts[0]?.includes("/")) { const progress = parts.shift(); if (!canonicalProgress(progress)) return undefined; result.progress = progress; }
 if (parts[0]?.startsWith("running ")) { const running = parts.shift()?.slice("running ".length); if (!canonicalInteger(running)) return undefined; result.running = running; }
 if (parts[0]?.startsWith("queued ")) { const queued = parts.shift()?.slice("queued ".length); if (!canonicalInteger(queued)) return undefined; result.queued = queued; }
 if (parts[0]?.startsWith("input ")) { const pending = parts.shift()?.slice("input ".length); if (!canonicalInteger(pending)) return undefined; result.pending = pending; }
 if (parts[0]?.startsWith("terminal ")) {
  const terminal = parts.shift()?.slice("terminal ".length);
  if (terminal !== "completed" && terminal !== "cancelled" && terminal !== "failed") return undefined;
  result.terminal = terminal;
 }
 return parts.length === 0 && !(result.terminal && (result.state === "blocked" || result.state === "input")) ? result : undefined;
};
const exactMetadataTokens = (value: unknown): value is HerdrMetadataTokens => {
 if (!isPlainObject(value) || !exactOwnedTokens(value)) return false;
 const tokens = value as Record<string, unknown>;
 if (!Object.values(tokens).every(token => token === null || (typeof token === "string" && Buffer.byteLength(token, "utf8") <= 128 && !hasControlOrBidi(token)))) return false;
 const summary = parseSummary(tokens.summary);
 if (!summary) return false;
 if (!(tokens.v2_progress === null || canonicalProgress(tokens.v2_progress))) return false;
 if (!(tokens.v2_attention === null || canonicalAttention(tokens.v2_attention))) return false;
 if (!(tokens.v2_interaction === null || canonicalInteraction(tokens.v2_interaction))) return false;
 if (!(tokens.v2_subagents === null || canonicalSubagents(tokens.v2_subagents))) return false;
 // Summary is a derived projection, not an independently supplied display string.
 if (tokens.v2_progress === null ? summary.progress !== undefined : summary.progress !== undefined && summary.progress !== tokens.v2_progress) return false;
 if (tokens.v2_subagents === null) {
  if (summary.running !== undefined || summary.queued !== undefined) return false;
 } else {
  const [running, , queued] = tokens.v2_subagents.split(",");
  if (summary.running !== undefined && summary.running !== running) return false;
  if (summary.queued !== undefined && summary.queued !== queued) return false;
 }
 if (tokens.v2_interaction === null) {
  if (summary.state === "input" || summary.pending !== undefined) return false;
 } else {
  const pending = tokens.v2_interaction.slice("ask_user:".length);
  if (summary.state !== "input" || summary.pending !== pending) return false;
 }
 if (!(tokens.tokens === null || canonicalDecimal(tokens.tokens)) || !(tokens.cost === null || canonicalDecimal(tokens.cost)) || !(tokens.context === null || canonicalDecimal(tokens.context))) return false;
 if (tokens.v2_terminals === null || tokens.v2_terminal_overflow === null) return tokens.v2_terminals === null && tokens.v2_terminal_overflow === null && summary.terminal === undefined;
 if (!canonicalInteger(tokens.v2_terminal_overflow) || typeof tokens.v2_terminals !== "string" || Buffer.byteLength(tokens.v2_terminals, "utf8") > 80) return false;
 const batch = parseTerminalBatch(tokens.v2_terminals, Number(tokens.v2_terminal_overflow));
 // The terminal batch is canonically sorted, while summary follows accepted
 // arrival order. A terminal segment therefore need only be an encoded outcome.
 if (!batch) return false;
 return !summary.terminal || batch.records.some(record => record.outcome === summary.terminal);
};
const sessionRef = (p:Record<string,unknown>) => safeText(p.agent_session_id,128) && p.agent_session_path === undefined;
/** Validates Herdr v8's safe presentation and complete V2 token patch. */
/** Companion is token-only: it cannot alter managed presentation or authority. */
export function isExactCompanionMetadataParams(value: unknown): value is Record<string, unknown> & { tokens: HerdrMetadataTokens } {
 const p = value as Record<string, unknown>;
 return isPlainObject(value)
  && own(p, COMPANION_METADATA_PARAM_KEYS, COMPANION_METADATA_PARAM_KEYS)
  && safeText(p.pane_id, 256)
  && p.source === COMPANION_METADATA_SOURCE
  && p.applies_to_source === LIFECYCLE_SOURCE
  && Number.isSafeInteger(p.seq)
  && (p.seq as number) >= 0
  && exactMetadataTokens(p.tokens);
}
export function isExactCompanionMetadataClearParams(value: unknown): value is Record<string, unknown> & { tokens: Record<string, null> } {
 const p = value as Record<string, unknown>;
 return isPlainObject(value)
  && own(p, COMPANION_METADATA_PARAM_KEYS, COMPANION_METADATA_PARAM_KEYS)
  && safeText(p.pane_id, 256)
  && p.source === COMPANION_METADATA_SOURCE
  && p.applies_to_source === LIFECYCLE_SOURCE
  && Number.isSafeInteger(p.seq)
  && (p.seq as number) >= 0
  && isPlainObject(p.tokens)
  && exactOwnedTokens(p.tokens as Record<string, unknown>)
  && Object.values(p.tokens).every(token => token === null);
}
export function isExactMetadataIngressParams(value: unknown): value is Record<string, unknown> & { tokens: HerdrMetadataTokens } {
 const p = value as Record<string, unknown>;
 return isPlainObject(value)
  && own(p, METADATA_PARAM_KEYS, METADATA_PARAM_KEYS)
  && safeText(p.pane_id, 256)
  && p.source === LIFECYCLE_SOURCE
  && p.applies_to_source === LIFECYCLE_SOURCE
  && p.agent === "pi"
  && Number.isSafeInteger(p.seq)
  && (p.seq as number) >= 0
  && p.display_agent === HERDR_FIXED_PRESENTATION.displayAgent
  && exactPresentation(p.state_labels)
  && exactMetadataTokens(p.tokens)
  && p.title === titleForSummary(p.tokens.summary);
}
/** Teardown uses Herdr's explicit v8 presentation-clear flags with the same token patch. */
export function isExactMetadataClearParams(value: unknown): value is Record<string, unknown> & { tokens: HerdrMetadataTokens } {
 const p = value as Record<string, unknown>;
 return isPlainObject(value)
  && own(p, METADATA_CLEAR_PARAM_KEYS, METADATA_CLEAR_PARAM_KEYS)
  && safeText(p.pane_id, 256)
  && p.source === LIFECYCLE_SOURCE
  && p.applies_to_source === LIFECYCLE_SOURCE
  && p.agent === "pi"
  && Number.isSafeInteger(p.seq)
  && (p.seq as number) >= 0
  && p.clear_title === true && p.clear_display_agent === true && p.clear_state_labels === true
  && isPlainObject(p.tokens)
  && exactOwnedTokens(p.tokens as Record<string, unknown>)
  && Object.values(p.tokens).every(token => token === null);
}
/** A token-only patch clears the exact pre-V2 allowlist without touching presentation. */
export function isExactLegacyMetadataClearParams(value: unknown): value is Record<string, unknown> & { tokens: HerdrLegacyMetadataTokens } {
 const p = value as Record<string, unknown>;
 return isPlainObject(value)
  && own(p, METADATA_LEGACY_CLEAR_PARAM_KEYS, METADATA_LEGACY_CLEAR_PARAM_KEYS)
  && safeText(p.pane_id, 256)
  && p.source === LIFECYCLE_SOURCE
  && p.applies_to_source === LIFECYCLE_SOURCE
  && p.agent === "pi"
  && Number.isSafeInteger(p.seq)
  && (p.seq as number) >= 0
  && isPlainObject(p.tokens)
  && exactTokens(p.tokens as Record<string, unknown>, HERDR_LEGACY_METADATA_TOKEN_KEYS)
  && Object.values(p.tokens).every(token => token === null);
}
/** Herdr clears only the authority claimed by this source; no agent or metadata fields are accepted. */
export function isExactAgentAuthorityClearParams(value: unknown): value is Record<string, unknown> {
 const p = value as Record<string, unknown>;
 return isPlainObject(value)
  && own(p, AGENT_AUTHORITY_CLEAR_PARAM_KEYS, AGENT_AUTHORITY_CLEAR_PARAM_KEYS)
  && safeText(p.pane_id, 256)
  && p.source === LIFECYCLE_SOURCE
  && Number.isSafeInteger(p.seq)
  && (p.seq as number) >= 0;
}
function valid(request: HerdrRequest): boolean {
 const p = request.params; if (!safeText(request.id, 128) || !safeText(request.method, 64)) return false;
 const base = safeText(p.pane_id, 256) && safeText(p.source, 64);
 switch (request.method) {
 case "pane.report_agent": return base && own(p,["pane_id","source","agent","state","message","seq","agent_session_id"],["pane_id","source","agent","state","seq"]) && p.source === LIFECYCLE_SOURCE && p.agent === "pi" && state.has(p.state as string) && Number.isSafeInteger(p.seq) && (p.seq as number) >= 0 && (p.message === undefined || p.message === null || safeText(p.message)) && sessionRef(p);
 case "pane.report_agent_session": return base && own(p,["pane_id","source","agent","seq","agent_session_id","session_start_source"],["pane_id","source","agent","seq"]) && p.source === LIFECYCLE_SOURCE && p.agent === "pi" && Number.isSafeInteger(p.seq) && (p.seq as number) >= 0 && sessionRef(p) && (p.session_start_source === undefined || safeText(p.session_start_source));
 case "pane.report_metadata": return base && (isExactMetadataIngressParams(p) || isExactCompanionMetadataParams(p) || isExactCompanionMetadataClearParams(p) || isExactMetadataClearParams(p) || isExactLegacyMetadataClearParams(p));
 case "pane.clear_agent_authority": return base && isExactAgentAuthorityClearParams(p);
 case "notification.show": return own(p,["title","body","sound"],["title","body","sound"]) && safeText(p.title,128) && safeText(p.body,512) && ["none","done","request"].includes(p.sound as string);
 }
}
export function encodeHerdrRequest(request: HerdrRequest): string { if (!isPlainObject(request.params) || !valid(request)) throw new PresenceProtocolError("Invalid Herdr request."); const line=JSON.stringify(request); if (Buffer.byteLength(line,"utf8") > HERDR_MAX_LINE_BYTES || /[\r\n]/.test(line)) throw new PresenceProtocolError("Herdr request exceeds bound."); return `${line}\n`; }
/** Strict Herdr response envelope: one matching id and either result or a complete error. */
export function decodeHerdrResponse(line: string, id: string): unknown { if (!line || /[\r\n]/.test(line) || Buffer.byteLength(line,"utf8") > HERDR_MAX_LINE_BYTES) throw new PresenceProtocolError("Invalid Herdr response line."); let value: unknown; try { value=JSON.parse(line); } catch { throw new PresenceProtocolError("Invalid Herdr JSON response."); } if (!isPlainObject(value) || value.id !== id) throw new PresenceProtocolError("Invalid Herdr response envelope."); if (own(value,["id","result"],["id","result"])) return value.result; if (own(value,["id","error"],["id","error"]) && isPlainObject(value.error) && own(value.error,["code","message"],["code","message"]) && safeText(value.error.code,128) && safeText(value.error.message,512)) throw new PresenceProtocolError("Herdr remote error."); throw new PresenceProtocolError("Invalid Herdr response envelope."); }
