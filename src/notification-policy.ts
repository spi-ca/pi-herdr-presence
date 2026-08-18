export type NotificationPolicy = "errors" | "background" | "settled" | "all" | "disabled";
export type NotificationSeverity = "error" | "attention" | "success" | "info" | "long-running";
export type NotificationCooldownKind = "error" | "input" | "blocked" | "other";

/** Policy is applied to static local text only, never producer-provided content. */
export function shouldNotify(policy: NotificationPolicy, enabled: boolean, severity: NotificationSeverity, origin: "local" | "external"): boolean {
  if (!enabled || policy === "disabled") return false;
  if (severity === "error" || severity === "attention") return true;
  if (policy === "errors") return false;
  if (policy === "all") return true;
  if (policy === "settled") return severity === "success" && origin === "local";
  return origin === "external" || severity === "long-running";
}

/** Fixed TTL/LRU gate: a repeated visible edge cannot grow retained state. */
export class NotificationDeduper {
  private readonly entries = new Map<string, number>();
  constructor(private readonly ttlMs = 60_000, private readonly limit = 64) {}
  accept(key: string, now = Date.now()): boolean {
    for (const [candidate, expires] of this.entries) if (expires <= now) this.entries.delete(candidate);
    const expires = this.entries.get(key);
    if (expires !== undefined) { this.entries.delete(key); this.entries.set(key, expires); return false; }
    this.entries.set(key, now + this.ttlMs);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }
  canAccept(key: string, now = Date.now()): boolean {
    for (const [candidate, expires] of this.entries) if (expires <= now) this.entries.delete(candidate);
    return !this.entries.has(key);
  }
  clear() { this.entries.clear(); }
}

/** Session-local fixed-window backstop; each first actionable kind remains deliverable once. */
export class NotificationRateLimiter {
  private timestamps: number[] = [];
  private readonly actionable = new Set<Exclude<NotificationCooldownKind, "other">>();
  constructor(private readonly windowMs = 60_000, private readonly limit = 8) {}
  accept(kind: NotificationCooldownKind, now = Date.now()): boolean {
    this.timestamps = this.timestamps.filter(timestamp => timestamp + this.windowMs > now);
    if (kind !== "other" && !this.actionable.has(kind)) { this.actionable.add(kind); return true; }
    if (this.timestamps.length >= this.limit) return false;
    this.timestamps.push(now);
    return true;
  }
  clear() { this.timestamps = []; this.actionable.clear(); }
}

/** Bounded per-source semantic fence for V2 state transitions. */
export class ExternalAttentionTransitions {
  private readonly entries = new Map<string, { generation: number; attention: "success" | "error" }>();

  constructor(private readonly limit = 64) {}

  accept(sourceId: string, generation: number, attention: "success" | "error"): boolean {
    const previous = this.entries.get(sourceId);
    if (previous?.generation === generation && previous.attention === attention) return false;
    this.entries.delete(sourceId);
    this.entries.set(sourceId, { generation, attention });
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
    return true;
  }

  remove(sourceId: string) { this.entries.delete(sourceId); }
  clear() { this.entries.clear(); }
}
