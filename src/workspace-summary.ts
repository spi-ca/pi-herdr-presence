import { WORKSPACE_MAIN_SUMMARY_HEARTBEAT_MS } from "./protocol.js";

export type WorkspaceSummaryPublisher = {
  workspaceMainSummary(summary: string): Promise<void>;
};

export type WorkspaceSummaryTimer = ReturnType<typeof setTimeout>;

/** A small timer seam keeps lease pacing deterministic without exposing runtime internals. */
export type WorkspaceSummaryScheduler = {
  setTimeout(callback: () => void, delayMs: number): WorkspaceSummaryTimer;
  clearTimeout(timer: WorkspaceSummaryTimer): void;
};

const systemScheduler: WorkspaceSummaryScheduler = {
  setTimeout(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    timer.unref?.();
    return timer;
  },
  clearTimeout(timer) { clearTimeout(timer); },
};

/**
 * Keeps the workspace summary lease alive without owning eligibility, wire
 * encoding, or cleanup. A completed attempt alone starts the next heartbeat.
 */
export class WorkspaceSummaryLease {
  private summary: string | null = null;
  private timer: WorkspaceSummaryTimer | undefined;
  private generation = 0;
  private active = false;
  private publishing = false;

  constructor(
    private readonly publisher: WorkspaceSummaryPublisher,
    private readonly scheduler: WorkspaceSummaryScheduler = systemScheduler,
    private readonly heartbeatMs = WORKSPACE_MAIN_SUMMARY_HEARTBEAT_MS,
  ) {}

  update(summary: string | null): void {
    this.summary = summary;
  }

  /** Begin one immediate best-effort publication followed by completion-relative heartbeats. */
  start(): Promise<void> {
    if (this.active) return Promise.resolve();
    this.active = true;
    this.generation += 1;
    return this.publish(this.generation);
  }

  /** Fence pending and in-flight attempts. The lease deliberately never clears workspace state. */
  stop(): void {
    this.active = false;
    this.generation += 1;
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer);
    this.timer = undefined;
  }

  private isCurrent(generation: number): boolean {
    return this.active && generation === this.generation;
  }

  private publish(generation: number): Promise<void> {
    if (!this.isCurrent(generation) || this.publishing) return Promise.resolve();
    this.publishing = true;
    return this.completePublication(generation);
  }

  private async completePublication(generation: number): Promise<void> {
    const summary = this.summary;
    try {
      if (summary) await this.publisher.workspaceMainSummary(summary);
    } catch {
      // Workspace output is observer-only. A later heartbeat gets another attempt.
    } finally {
      this.publishing = false;
    }

    if (!this.isCurrent(generation)) {
      if (this.active) void this.publish(this.generation);
      return;
    }
    this.schedule(generation);
  }

  private schedule(generation: number): void {
    const timer = this.scheduler.setTimeout(() => {
      if (this.timer !== timer || !this.isCurrent(generation)) return;
      this.timer = undefined;
      void this.publish(generation);
    }, this.heartbeatMs);
    this.timer = timer;
  }
}
