type PresenceUsage = { tokens?: number; cost?: number; contextPercent?: number };

interface UsageLike { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; cost?: unknown; }
const LIMIT = 1_000_000;
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(LIMIT, value) : 0; }
function percent(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined; }
function cost(value: unknown): number { return typeof value === "number" ? number(value) : typeof value === "object" && value !== null ? number((value as { total?: unknown }).total) : 0; }

/** Aggregate only approved numeric usage; snapshots are bounded for wire projection. */
export class UsageTracker {
  private tokens = 0;
  private reportedCost = 0;
  private contextPercent: number | undefined;

  add(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const usage = value as UsageLike;
    const total = number(usage.totalTokens);
    this.tokens = Math.min(LIMIT, this.tokens + (total || number(usage.input) + number(usage.output) + number(usage.cacheRead) + number(usage.cacheWrite)));
    this.reportedCost = Math.min(LIMIT, this.reportedCost + cost(usage.cost));
  }
  setContext(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const usage = value as { percent?: unknown; contextPercent?: unknown };
    this.contextPercent = percent(usage.contextPercent) ?? percent(usage.percent) ?? this.contextPercent;
  }
  snapshot(): PresenceUsage | undefined {
    const usage: PresenceUsage = {};
    if (this.tokens > 0) usage.tokens = this.tokens;
    if (this.reportedCost > 0) usage.cost = this.reportedCost;
    if (this.contextPercent !== undefined) usage.contextPercent = this.contextPercent;
    return Object.keys(usage).length > 0 ? usage : undefined;
  }
}
