export type NotificationPolicy = "errors" | "background" | "settled" | "all" | "disabled";
export type NotificationSeverity = "error" | "attention" | "success" | "info" | "long-running";
export type NotificationCooldownKind = "error" | "input" | "blocked" | "other";

/** Policy is applied to static local text only, never producer-provided content. */
export function shouldNotify(policy: NotificationPolicy, enabled: boolean, severity: NotificationSeverity, origin: "local" | "external"): boolean {
  if (!enabled || policy === "disabled") return false;
  if (severity === "error" || severity === "attention") return true;
  if (policy === "errors") return false;
  if (policy === "settled") return severity === "success" && origin === "local";
  if (severity === "long-running") return origin === "local";
  if (policy === "all") return true;
  return origin === "external";
}

/** A reservation is inert after either terminal operation; neither operation calls user code. */
export type NotificationReservation = { commit(now?: number): boolean; release(): void };

/** Fixed TTL/LRU gate with bounded pending keys that block duplicate queue admission. */
export class NotificationDeduper {
  private readonly entries = new Map<string, number>();
  private readonly pending = new Map<string, NotificationReservation>();
  constructor(private readonly ttlMs = 60_000, private readonly limit = 64) {}
  private prune(now: number) {
    for (const [candidate, expires] of this.entries) if (expires <= now) this.entries.delete(candidate);
  }
  reserve(key: string, now = Date.now()): NotificationReservation | undefined {
    this.prune(now);
    if (this.entries.has(key) || this.pending.has(key) || this.pending.size >= this.limit) return undefined;
    let live = true;
    const reservation: NotificationReservation = {
      commit: (committedAt = Date.now()) => {
        if (!live || this.pending.get(key) !== reservation) return false;
        live = false;
        this.pending.delete(key);
        this.prune(committedAt);
        this.entries.set(key, committedAt + this.ttlMs);
        while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
        return true;
      },
      release: () => {
        if (!live || this.pending.get(key) !== reservation) return;
        live = false;
        this.pending.delete(key);
      },
    };
    this.pending.set(key, reservation);
    return reservation;
  }
  accept(key: string, now = Date.now()): boolean {
    this.prune(now);
    const expires = this.entries.get(key);
    if (expires !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, expires);
      return false;
    }
    const reservation = this.reserve(key, now);
    return reservation?.commit(now) === true;
  }
  canAccept(key: string, now = Date.now()): boolean {
    this.prune(now);
    return !this.entries.has(key) && !this.pending.has(key) && this.pending.size < this.limit;
  }
  clear() { this.entries.clear(); this.pending.clear(); }
}

/** Session-local fixed-window backstop with bounded transactional queue reservations. */
export class NotificationRateLimiter {
  private timestamps: number[] = [];
  private readonly actionable = new Set<Exclude<NotificationCooldownKind, "other">>();
  private readonly pending = new Map<symbol, { kind: NotificationCooldownKind; first: boolean; reservation: NotificationReservation }>();
  constructor(private readonly windowMs = 60_000, private readonly limit = 8) {}
  private prune(now: number) {
    this.timestamps = this.timestamps.filter(timestamp => timestamp + this.windowMs > now);
  }
  private pendingWindowCount() {
    let count = 0;
    for (const pending of this.pending.values()) if (!pending.first) count += 1;
    return count;
  }
  private pendingFirst(kind: Exclude<NotificationCooldownKind, "other">) {
    for (const pending of this.pending.values()) if (pending.first && pending.kind === kind) return true;
    return false;
  }
  /** Preflight includes outstanding reservations, so synchronous admissions cannot oversubscribe capacity. */
  canAccept(kind: NotificationCooldownKind, now = Date.now()): boolean {
    this.prune(now);
    return (kind !== "other" && !this.actionable.has(kind) && !this.pendingFirst(kind))
      || this.timestamps.length + this.pendingWindowCount() < this.limit;
  }
  reserve(kind: NotificationCooldownKind, now = Date.now()): NotificationReservation | undefined {
    if (!this.canAccept(kind, now) || this.pending.size >= this.limit + 3) return undefined;
    const first = kind !== "other" && !this.actionable.has(kind) && !this.pendingFirst(kind);
    const id = Symbol(kind);
    let live = true;
    const reservation: NotificationReservation = {
      commit: (committedAt = Date.now()) => {
        const pending = this.pending.get(id);
        if (!live || pending?.reservation !== reservation) return false;
        live = false;
        this.pending.delete(id);
        this.prune(committedAt);
        if (first) this.actionable.add(kind as Exclude<NotificationCooldownKind, "other">);
        else this.timestamps.push(committedAt);
        return true;
      },
      release: () => {
        if (!live || this.pending.get(id)?.reservation !== reservation) return;
        live = false;
        this.pending.delete(id);
      },
    };
    this.pending.set(id, { kind, first, reservation });
    return reservation;
  }
  /** Compatible immediate commit API. */
  commit(kind: NotificationCooldownKind, now = Date.now()): boolean {
    const reservation = this.reserve(kind, now);
    return reservation?.commit(now) === true;
  }
  accept(kind: NotificationCooldownKind, now = Date.now()): boolean { return this.commit(kind, now); }
  clear() { this.timestamps = []; this.actionable.clear(); this.pending.clear(); }
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
