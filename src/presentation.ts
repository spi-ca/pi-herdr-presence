import type { PresenceStateV2, PresenceTerminalV2, Subagents, TerminalBatch } from "@pi/presence";
import { HERDR_FIXED_PRESENTATION, type HerdrMetadataTokens, type HerdrPresentation } from "./protocol.js";
import { boundedPresenceText } from "./text.js";

export type HerdrState = "idle" | "working" | "blocked" | "unknown";
export type BlockedCategory = "ask-user" | "blocked";
type Usage = { tokens?: number; cost?: number; contextPercent?: number } | undefined;
type LatestTerminalOutcome = PresenceTerminalV2["outcome"] | undefined;

const LIMIT = 1_000_000;
const SUMMARY_MAX_BYTES = 80;
const SUMMARY_MAX_CODE_POINTS = 80;
const count = (value: unknown): number | undefined => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= LIMIT ? value : undefined;
/** Decimal only, no exponent/sign/trailing zero ambiguity, and capped to the shared numeric budget. */
function decimal(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > LIMIT) return null;
  const result = Number.isInteger(value) ? String(value) : value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(result) && result.length <= 16 ? result : null;
}

export function isInteractionWaiting(event: PresenceStateV2): boolean {
  return event.source === "interaction" && event.state === "waiting" && event.interaction?.kind === "ask_user" && event.interaction.pending > 0;
}
export function isLiveInputRequest(event: PresenceStateV2): boolean {
  return isInteractionWaiting(event) && event.attention?.reason === "input_required" && event.attention.occurrence === "new";
}
const hasFailure = (event: PresenceStateV2) => event.state === "error" || event.attention?.reason === "failure";
const hasBlockedAttention = (event: PresenceStateV2) => event.attention?.reason === "blocked";
const sourceOrder: Record<PresenceStateV2["source"], number> = { interaction: 0, pi: 1, subagent: 2, todo: 3 };
const attentionReasonOrder: Record<string, number> = { input_required: 0, failure: 1, blocked: 2 };
const attentionOccurrenceOrder: Record<string, number> = { new: 0, retained: 1 };
const compareAttention = (left: PresenceStateV2, right: PresenceStateV2) =>
  (attentionReasonOrder[left.attention?.reason ?? ""] ?? 3) - (attentionReasonOrder[right.attention?.reason ?? ""] ?? 3)
  || (attentionOccurrenceOrder[left.attention?.occurrence ?? ""] ?? 2) - (attentionOccurrenceOrder[right.attention?.occurrence ?? ""] ?? 2)
  || sourceOrder[left.source] - sourceOrder[right.source]
  || left.generation - right.generation || left.sequence - right.sequence;
const progressSourceOrder: Partial<Record<PresenceStateV2["source"], number>> = { todo: 0, subagent: 1, pi: 2 };
const compareProgress = (left: PresenceStateV2, right: PresenceStateV2) =>
  (progressSourceOrder[left.source] ?? 3) - (progressSourceOrder[right.source] ?? 3)
  || sourceOrder[left.source] - sourceOrder[right.source]
  || left.generation - right.generation || left.sequence - right.sequence;
const subagents = (events: readonly PresenceStateV2[]): Subagents | undefined => events.find(event => event.source === "subagent")?.subagents;

export function blockedPresentationCategory(events: readonly PresenceStateV2[]): BlockedCategory {
  return events.some(isInteractionWaiting) ? "ask-user" : "blocked";
}
export function compositeState(events: readonly PresenceStateV2[], active: boolean): HerdrState {
  if (events.some(hasFailure) || events.some(hasBlockedAttention) || events.some(isInteractionWaiting)) return "blocked";
  if (active || events.some(event => event.state === "running" || event.state === "waiting")) return "working";
  return "idle";
}
/** Only fixed, privacy-safe strings reach pane state messages and labels. */
export function safeMessage(state: HerdrState, max: number, events: readonly PresenceStateV2[] = [], parentActive = false): string {
  const aggregate = subagents(events);
  const category = blockedPresentationCategory(events);
  const text = state === "blocked"
    ? category === "ask-user" ? "Pi needs your input" : "Pi needs attention"
    : state === "working" && parentActive ? "Pi is working"
    : state === "working" && aggregate?.cancelling ? "Subagents are stopping"
    : state === "working" && aggregate?.running ? "Subagents are working"
    : state === "working" && aggregate?.queued ? "Subagents are queued"
    : state === "working" ? "Pi is working"
    : state === "idle" ? "Pi is idle" : "Pi state unknown";
  return boundedPresenceText(text, { maxBytes: 128, maxCodePoints: max });
}

/** Display agent and state labels are fixed; standalone title derives from the safe summary token. */
export function presentation(): HerdrPresentation { return HERDR_FIXED_PRESENTATION; }

function addSummarySegment(parts: string[], value: string, reserve = 0) {
  const candidate = [...parts, value].join(" · ");
  if (Buffer.byteLength(candidate, "utf8") + reserve <= SUMMARY_MAX_BYTES && [...candidate].length + reserve <= SUMMARY_MAX_CODE_POINTS) parts.push(value);
}
function terminalSegment(outcome: LatestTerminalOutcome): string | undefined {
  return outcome === "completed" || outcome === "cancelled" || outcome === "failed" ? `terminal ${outcome}` : undefined;
}
/** A bounded fixed-order grammar; terminal outcome is arrival-derived, never canonical-sort-derived. */
function summary(events: readonly PresenceStateV2[], state: HerdrState, progressToken: string | null, interactionToken: string | null, latestTerminal?: LatestTerminalOutcome): string {
  const aggregate = subagents(events);
  const stateSegment = state === "blocked" && interactionToken ? "input" : state;
  // Blocking, input, and failure all resolve to blocked and intentionally hide
  // the transient terminal. Otherwise retain semantic working/idle plus the
  // newest accepted terminal arrival as a closed trailing segment.
  const terminal = state === "blocked" || stateSegment === "input" ? undefined : terminalSegment(latestTerminal);
  const parts = [stateSegment];
  const reserve = terminal ? Buffer.byteLength(` · ${terminal}`, "utf8") : 0;
  if (progressToken) addSummarySegment(parts, progressToken, reserve);
  const running = aggregate && count(aggregate.running);
  const queued = aggregate && count(aggregate.queued);
  const pending = interactionToken?.slice("ask_user:".length);
  if (running !== undefined) addSummarySegment(parts, `running ${running}`, reserve);
  if (queued !== undefined) addSummarySegment(parts, `queued ${queued}`, reserve);
  if (pending !== undefined) addSummarySegment(parts, `input ${pending}`, reserve);
  if (terminal) addSummarySegment(parts, terminal);
  return parts.join(" · ");
}

/** Ten local Herdr keys: every unavailable datum except derived summary is null. */
export function metadata(events: readonly PresenceStateV2[], terminals?: TerminalBatch, usage?: Usage, parentActive = false, state = compositeState(events, parentActive), latestTerminal?: LatestTerminalOutcome): HerdrMetadataTokens {
  const progress = [...events].filter(event => event.progress).sort(compareProgress)[0]?.progress;
  const attention = [...events].filter(event => event.attention).sort(compareAttention)[0]?.attention;
  const interaction = events.find(isInteractionWaiting)?.interaction;
  const aggregate = subagents(events);
  const progressToken = progress && count(progress.completed) !== undefined && count(progress.total) !== undefined ? `${progress.completed}/${progress.total}` : null;
  const attentionToken = attention ? `${attention.reason}:${attention.occurrence}` : null;
  const interactionToken = interaction && count(interaction.pending) !== undefined ? `ask_user:${interaction.pending}` : null;
  const subagentValues = aggregate && [aggregate.running, aggregate.cancelling, aggregate.queued, aggregate.completed, aggregate.failed, aggregate.cancelled, aggregate.omitted];
  const subagentToken = subagentValues?.every(value => count(value) !== undefined) ? subagentValues.join(",") : null;
  return {
    summary: summary(events, state, progressToken, interactionToken, latestTerminal),
    v2_progress: progressToken,
    v2_attention: attentionToken,
    v2_interaction: interactionToken,
    v2_subagents: subagentToken,
    v2_terminals: terminals?.value ?? null,
    v2_terminal_overflow: terminals ? String(terminals.overflow) : null,
    tokens: decimal(usage?.tokens),
    cost: decimal(usage?.cost),
    context: decimal(usage?.contextPercent),
  };
}
export function attentionText(event: PresenceStateV2, max: number): { title: string; body: string; error: boolean; inputNeeded: boolean } | null {
  const reason = event.attention?.reason;
  if (!reason || event.attention?.occurrence !== "new") return null;
  const inputNeeded = isLiveInputRequest(event);
  const error = reason === "failure" || reason === "blocked";
  return {
    title: boundedPresenceText(inputNeeded ? "Pi needs your input" : error ? "Pi needs attention" : "Pi update", { maxBytes: 128, maxCodePoints: max }),
    body: boundedPresenceText(inputNeeded ? "Pi needs your input" : error ? "A Pi task needs attention" : "Pi activity completed", { maxBytes: 512, maxCodePoints: max }),
    error,
    inputNeeded,
  };
}
