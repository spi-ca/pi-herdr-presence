import type { PresenceUsage } from "./events.js";

interface UsageLike { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; cost?: unknown; }
function number(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0; }
function percent(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined; }
function cost(value: unknown): number {
  if (typeof value === "number") return number(value);
  if (typeof value === "object" && value !== null) return number((value as { total?: unknown }).total);
  return 0;
}

export class UsageTracker {
  private tokens = 0;
  private reportedCost = 0;
  private contextPercent: number | undefined;

  /** Add one assistant message usage delta; repeated calls accumulate per-message values. */
  add(value: unknown): void {
    if (typeof value !== "object" || value === null) return;
    const usage = value as UsageLike;
    const total = number(usage.totalTokens);
    this.tokens += total || number(usage.input) + number(usage.output) + number(usage.cacheRead) + number(usage.cacheWrite);
    this.reportedCost += cost(usage.cost);
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
