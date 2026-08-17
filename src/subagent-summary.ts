import { PI_PRESENCE_SUMMARY_EVENT, type PresenceRemove, type PresenceUpdate } from "./events.js";
import { hasControlOrBidi, isPlainObject } from "./validation.js";

export { PI_PRESENCE_SUMMARY_EVENT };
const ROOT_KEYS = ["version", "sessionId", "generation", "sequence", "source", "active", "waiting", "terminal", "omitted"];
const SOURCE_KEYS = ["id"];
const ACTIVE_KEYS = ["id", "agent", "status", "category", "startedAt"];
const WAITING_KEYS = ["category", "count"];
const TERMINAL_KEYS = ["id", "agent", "status", "completedAt"];
const MAX_TEXT = 96;
const MAX_COUNT = 1_000_000;
const MAX_ACTIVE = 8;

export interface SubagentSummary {
  version: 1;
  sessionId: string;
  generation: number;
  sequence: number;
  source: { id: string };
  active: Array<{ id: string; agent: string; status: "running" | "cancelling"; category: "active" | "cancelling"; startedAt: number }>;
  waiting?: { category: "queued" | "cancelling"; count: number };
  terminal?: { id: string; agent: string; status: "completed" | "failed" | "cancelled"; completedAt: number };
  omitted: number;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.hasOwn(value, key); }
function snapshotOwnDataFields(value: unknown, allowed: readonly string[], required: readonly string[]): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === "string" && allowed.includes(key)) || !required.every((key) => keys.includes(key))) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[key as string] = descriptor.value;
  }
  return snapshot;
}
function snapshotDenseArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor) || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > maximum) return null;
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1 || !keys.every((key) => key === "length" || (typeof key === "string" && /^(?:0|[1-9]\d*)$/.test(key) && Number(key) < length))) return null;
  const values: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) return null;
    values.push(descriptor.value);
  }
  return values;
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT * 2 && [...value].length <= MAX_TEXT && !hasControlOrBidi(value);
}
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function sequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT; }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER; }

/**
 * Strict, display-safe companion summary. It intentionally has no task, output,
 * error, path, socket, or target fields; parsed identifiers are never rendered.
 */
export function parseSubagentSummary(value: unknown): SubagentSummary | null {
  try {
    const root = snapshotOwnDataFields(value, ROOT_KEYS, ["version", "sessionId", "generation", "sequence", "source", "active", "omitted"]);
    if (!root || root.version !== 1 || !text(root.sessionId) || !generation(root.generation) || !sequence(root.sequence) || !count(root.omitted)) return null;
    const source = snapshotOwnDataFields(root.source, SOURCE_KEYS, SOURCE_KEYS);
    const active = snapshotDenseArray(root.active, MAX_ACTIVE);
    if (!source || !text(source.id) || !active) return null;
    const parsedActive: SubagentSummary["active"] = [];
    for (const rawItem of active) {
      const item = snapshotOwnDataFields(rawItem, ACTIVE_KEYS, ACTIVE_KEYS);
      if (!item || !text(item.id) || !text(item.agent) || (item.status !== "running" && item.status !== "cancelling")
        || (item.category !== "active" && item.category !== "cancelling") || !timestamp(item.startedAt)
        || (item.status === "cancelling") !== (item.category === "cancelling")) return null;
      parsedActive.push({ id: item.id, agent: item.agent, status: item.status, category: item.category, startedAt: item.startedAt });
    }
    let waiting: SubagentSummary["waiting"];
    if (hasOwn(root, "waiting")) {
      const rawWaiting = snapshotOwnDataFields(root.waiting, WAITING_KEYS, WAITING_KEYS);
      if (!rawWaiting || (rawWaiting.category !== "queued" && rawWaiting.category !== "cancelling") || !count(rawWaiting.count)) return null;
      waiting = { category: rawWaiting.category, count: rawWaiting.count };
    }
    let terminal: SubagentSummary["terminal"];
    if (hasOwn(root, "terminal")) {
      const rawTerminal = snapshotOwnDataFields(root.terminal, TERMINAL_KEYS, TERMINAL_KEYS);
      if (!rawTerminal || !text(rawTerminal.id) || !text(rawTerminal.agent)
        || (rawTerminal.status !== "completed" && rawTerminal.status !== "failed" && rawTerminal.status !== "cancelled") || !timestamp(rawTerminal.completedAt)) return null;
      terminal = { id: rawTerminal.id, agent: rawTerminal.agent, status: rawTerminal.status, completedAt: rawTerminal.completedAt };
    }
    return { version: 1, sessionId: root.sessionId, generation: root.generation, sequence: root.sequence, source: { id: source.id }, active: parsedActive, ...(waiting ? { waiting } : {}), ...(terminal ? { terminal } : {}), omitted: root.omitted };
  } catch { return null; }
}

type SubagentFence = { generation: number; sequence: number; kind: "update" | "remove" };
/**
 * Summary is a one-shot companion to an already accepted pi-subagent update.
 * It deliberately shares that update/remove fence, so a remove tombstone cannot
 * be bypassed by replaying a retained companion snapshot.
 */
export class SubagentSummaryFence {
  private current: SubagentFence | null = null;
  private companionAccepted = false;
  reset(): void { this.current = null; this.companionAccepted = false; }
  recordUpdate(event: PresenceUpdate): void { this.current = { generation: event.generation, sequence: event.sequence, kind: "update" }; this.companionAccepted = false; }
  recordRemove(event: PresenceRemove): void { this.current = { generation: event.generation, sequence: event.sequence, kind: "remove" }; this.companionAccepted = false; }
  acceptSummary(summary: SubagentSummary): boolean {
    const current = this.current;
    if (!current || this.companionAccepted || current.kind !== "update" || summary.generation !== current.generation || summary.sequence !== current.sequence) return false;
    this.companionAccepted = true;
    return true;
  }
}
