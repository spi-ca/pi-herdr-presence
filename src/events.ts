import { hasControlOrBidi, isPlainObject } from "./validation.js";

export const PI_PRESENCE_UPDATE_EVENT = "pi-presence:update:v1" as const;
export const PI_PRESENCE_REMOVE_EVENT = "pi-presence:remove:v1" as const;
export const PI_PRESENCE_READY_EVENT = "pi-presence:ready:v1" as const;
/** Bounded companion wire for subagent aggregate summaries. */
export const PI_PRESENCE_SUMMARY_EVENT = "pi-presence:summary:v1" as const;
const MAX_TEXT = 96;
const MAX_SOURCES = 64;
/** Each count is a safe integer in the inclusive range 0..1,000,000. */
export const MAX_COUNT = 1_000_000;
const STATES = new Set(["idle", "waiting", "running", "success", "error", "cancelled"]);
const ATTENTION = new Set(["none", "info", "success", "error"]);
const ROOT_KEYS = ["version", "sessionId", "generation", "sequence", "source", "state", "counts", "progress", "usage", "attention"];
const REMOVE_ROOT_KEYS = ["version", "sessionId", "generation", "sequence", "source"];
const READY_KEYS = ["version", "sessionId", "consumer"];
const CONSUMER_KEYS = ["id", "capabilities"];
const SOURCE_KEYS = ["id", "label", "kind"];
const REMOVE_SOURCE_KEYS = ["id"];
const COUNT_KEYS = ["active", "completed", "failed", "queued", "cancelled", "total"]; 
const REQUIRED_COUNT_KEYS = ["active", "completed", "failed"]; 
const PROGRESS_KEYS = ["value", "label"];
const USAGE_KEYS = ["tokens", "cost", "contextPercent"];

export interface PresenceUsage { tokens?: number; cost?: number; contextPercent?: number; }
export interface PresenceUpdate {
  version: 1;
  sessionId: string;
  generation: number;
  sequence: number;
  source: { id: string; label: string; kind: string };
  state: "idle" | "waiting" | "running" | "success" | "error" | "cancelled";
  counts: { active: number; completed: number; failed: number; queued?: number; cancelled?: number; total?: number }; 
  progress?: { value: number; label?: string };
  usage?: PresenceUsage;
  attention?: "none" | "info" | "success" | "error";
}

/** A producer withdrawal retains only its ordering fence, never its display state. */
export interface PresenceRemove {
  version: 1;
  sessionId: string;
  generation: number;
  sequence: number;
  source: { id: string };
}

export interface PresenceRemoveResult {
  readonly accepted: boolean;
  /** The exact retained update that was withdrawn, if one still existed. */
  readonly removed?: PresenceUpdate;
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key));
}
function hasOwn(value: Record<string, unknown>, key: string): boolean { return Object.hasOwn(value, key); }

/**
 * Copies only own data properties after checking the complete key set. Ready
 * payloads are process-local but untrusted: this avoids getter/proxy races and
 * makes every later validation read a stable snapshot.
 */
function snapshotOwnDataFields(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | null {
  if (!isPlainObject(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (!keys.every((key) => typeof key === "string" && allowed.includes(key))
    || !required.every((key) => keys.includes(key))) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
    snapshot[key as string] = descriptor.value;
  }
  return snapshot;
}

/** Copy a dense, bounded capability list without reading indexed accessors. */
function snapshotCapabilities(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const keys = Reflect.ownKeys(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (!lengthDescriptor || !("value" in lengthDescriptor)
    || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > 16) return null;
  const length = lengthDescriptor.value;
  if (keys.length !== length + 1
    || !keys.every((key) => key === "length"
      || (typeof key === "string"
        && /^(?:0|[1-9]\d*)$/.test(key)
        && Number(key) < length))) return null;
  const capabilities: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !safeText(descriptor.value)) return null;
    capabilities.push(descriptor.value);
  }
  return capabilities;
}
// Directional formatting marks can make a benign-looking target render differently.
function safeText(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_TEXT * 2
    && [...value].length <= MAX_TEXT
    && !hasControlOrBidi(value);
}

/** Validate the host session fence before any presence side effects are created. */
export function parsePresenceSessionId(value: unknown): string | null {
  return safeText(value) ? value : null;
}

function sequence(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1; }
function generation(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_COUNT; }
function metric(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000_000; }
function percent(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100; }

/**
 * Parse untrusted process-local event data into an owned DTO. This is total:
 * proxies and throwing accessors are rejected rather than escaping to Pi.
 */
export function parsePresenceUpdate(value: unknown): PresenceUpdate | null {
  try {
    if (!isPlainObject(value) || !hasOnlyKeys(value, ROOT_KEYS)) return null;
    if (!hasOwn(value, "version") || !hasOwn(value, "sessionId") || !hasOwn(value, "generation") || !hasOwn(value, "sequence") || !hasOwn(value, "source") || !hasOwn(value, "state") || !hasOwn(value, "counts")) return null;
    const version = value.version;
    const sessionId = value.sessionId;
    const eventGeneration = value.generation;
    const eventSequence = value.sequence;
    const rawSource = value.source;
    const state = value.state;
    const rawCounts = value.counts;
    if (version !== 1 || !safeText(sessionId) || !generation(eventGeneration) || !sequence(eventSequence) || !isPlainObject(rawSource) || !hasOnlyKeys(rawSource, SOURCE_KEYS) || !isPlainObject(rawCounts) || !hasOnlyKeys(rawCounts, COUNT_KEYS)) return null;
    if (!SOURCE_KEYS.every((key) => hasOwn(rawSource, key)) || !REQUIRED_COUNT_KEYS.every((key) => hasOwn(rawCounts, key))) return null;
    const sourceId = rawSource.id;
    const sourceLabel = rawSource.label;
    const sourceKind = rawSource.kind;
    const active = rawCounts.active;
    const completed = rawCounts.completed;
    const failed = rawCounts.failed;
    const queued = rawCounts.queued;
    const cancelled = rawCounts.cancelled;
    const total = rawCounts.total;
    if (!safeText(sourceId) || !safeText(sourceLabel) || !safeText(sourceKind) || typeof state !== "string" || !STATES.has(state) || !count(active) || !count(completed) || !count(failed) || (queued !== undefined && !count(queued)) || (cancelled !== undefined && !count(cancelled)) || (total !== undefined && !count(total))) return null;

    let progress: PresenceUpdate["progress"];
    if (value.progress !== undefined) {
      const rawProgress = value.progress;
      if (!isPlainObject(rawProgress) || !hasOnlyKeys(rawProgress, PROGRESS_KEYS) || !hasOwn(rawProgress, "value")) return null;
      const progressValue = rawProgress.value;
      const progressLabel = rawProgress.label;
      if (!metric(progressValue) || progressValue > 1 || (progressLabel !== undefined && !safeText(progressLabel))) return null;
      progress = progressLabel === undefined ? { value: progressValue } : { value: progressValue, label: progressLabel };
    }

    let usage: PresenceUsage | undefined;
    if (value.usage !== undefined) {
      const rawUsage = value.usage;
      if (!isPlainObject(rawUsage) || !hasOnlyKeys(rawUsage, USAGE_KEYS)) return null;
      const tokens = rawUsage.tokens;
      const cost = rawUsage.cost;
      const contextPercent = rawUsage.contextPercent;
      if ((tokens !== undefined && !metric(tokens)) || (cost !== undefined && !metric(cost)) || (contextPercent !== undefined && !percent(contextPercent))) return null;
      usage = {
        ...(tokens === undefined ? {} : { tokens }),
        ...(cost === undefined ? {} : { cost }),
        ...(contextPercent === undefined ? {} : { contextPercent }),
      };
    }

    const attention = value.attention;
    if (attention !== undefined && (typeof attention !== "string" || !ATTENTION.has(attention))) return null;
    return {
      version: 1, sessionId, generation: eventGeneration, sequence: eventSequence,
      source: { id: sourceId, label: sourceLabel, kind: sourceKind },
      state: state as PresenceUpdate["state"],
      counts: { active, completed, failed, ...(queued === undefined ? {} : { queued }), ...(cancelled === undefined ? {} : { cancelled }), ...(total === undefined ? {} : { total }) },
      ...(progress === undefined ? {} : { progress }),
      ...(usage === undefined ? {} : { usage }),
      ...(attention === undefined ? {} : { attention: attention as PresenceUpdate["attention"] }),
    };
  } catch {
    return null;
  }
}

/** Parse a withdrawal envelope without permitting producer-controlled display data. */
export function parsePresenceRemove(value: unknown): PresenceRemove | null {
  try {
    if (!isPlainObject(value) || !hasOnlyKeys(value, REMOVE_ROOT_KEYS)) return null;
    if (!hasOwn(value, "version") || !hasOwn(value, "sessionId") || !hasOwn(value, "generation") || !hasOwn(value, "sequence") || !hasOwn(value, "source")) return null;
    const version = value.version;
    const sessionId = value.sessionId;
    const eventGeneration = value.generation;
    const eventSequence = value.sequence;
    const rawSource = value.source;
    if (version !== 1 || !safeText(sessionId) || !generation(eventGeneration) || !sequence(eventSequence)
      || !isPlainObject(rawSource) || !hasOnlyKeys(rawSource, REMOVE_SOURCE_KEYS) || !hasOwn(rawSource, "id")) return null;
    const sourceId = rawSource.id;
    if (!safeText(sourceId)) return null;
    return {
      version: 1,
      sessionId,
      generation: eventGeneration,
      sequence: eventSequence,
      source: { id: sourceId },
    };
  } catch {
    return null;
  }
}

/** A ready event grants no authority: no consumer is a discovery/replay request, while a consumer is a passive advertisement. */
export interface PresenceReady { version: 1; sessionId: string; consumer?: { id: string; capabilities: string[] }; }
export function parsePresenceReady(value: unknown): PresenceReady | null {
  try {
    const root = snapshotOwnDataFields(value, READY_KEYS, ["version", "sessionId"]);
    if (!root || root.version !== 1 || !safeText(root.sessionId)) return null;
    if (!hasOwn(root, "consumer")) return { version: 1, sessionId: root.sessionId };

    const consumer = snapshotOwnDataFields(root.consumer, CONSUMER_KEYS, CONSUMER_KEYS);
    if (!consumer || !safeText(consumer.id)) return null;
    const capabilities = snapshotCapabilities(consumer.capabilities);
    if (!capabilities) return null;
    return { version: 1, sessionId: root.sessionId, consumer: { id: consumer.id, capabilities } };
  } catch { return null; }
}

interface SourceFence { generation: number; sequence: number; }

/**
 * A source owns its generation: a newer source generation resets only that
 * source's sequence fence. Session ownership remains with the consumer.
 */
export class PresenceEventRegistry {
  private sessionId: string | null = null;
  private readonly fenceBySource = new Map<string, SourceFence>();
  private readonly values = new Map<string, PresenceUpdate>();

  start(sessionId: string): void {
    if (parsePresenceSessionId(sessionId) === null) throw new Error("Invalid presence session fence.");
    this.sessionId = sessionId;
    this.fenceBySource.clear();
    this.values.clear();
  }
  stop(): void { this.sessionId = null; this.fenceBySource.clear(); this.values.clear(); }
  accept(candidate: unknown): boolean {
    const event = parsePresenceUpdate(candidate);
    return event !== null && this.acceptParsed(event);
  }
  acceptParsed(event: PresenceUpdate): boolean {
    if (event.sessionId !== this.sessionId) return false;
    const previous = this.fenceBySource.get(event.source.id);
    // Generic producers share a fixed process-local budget. Unknown removes do
    // not allocate fences, so they cannot consume this budget by themselves.
    if (!previous && this.fenceBySource.size >= MAX_SOURCES) return false;
    if (previous && (event.generation < previous.generation || (event.generation === previous.generation && event.sequence <= previous.sequence))) return false;
    this.fenceBySource.set(event.source.id, { generation: event.generation, sequence: event.sequence });
    this.values.set(event.source.id, event);
    return true;
  }
  acceptRemove(candidate: unknown): PresenceRemoveResult {
    const event = parsePresenceRemove(candidate);
    return event === null ? { accepted: false } : this.acceptParsedRemove(event);
  }
  acceptParsedRemove(event: PresenceRemove): PresenceRemoveResult {
    if (event.sessionId !== this.sessionId
      || event.source.id === "pi"
      || event.source.id === "pi-todo") return { accepted: false };
    const previous = this.fenceBySource.get(event.source.id);
    // Never allocate a tombstone for an unknown external remove: otherwise a
    // same-process producer could consume all source fences without publishing.
    if (!previous
      || event.generation < previous.generation
      || (event.generation === previous.generation && event.sequence <= previous.sequence)) {
      return { accepted: false };
    }
    const removed = this.values.get(event.source.id);
    this.fenceBySource.set(event.source.id, { generation: event.generation, sequence: event.sequence });
    this.values.delete(event.source.id);
    return { accepted: true, ...(removed ? { removed } : {}) };
  }
  snapshot(): PresenceUpdate[] { return [...this.values.values()].sort((left, right) => left.source.label.localeCompare(right.source.label)); }
}
