import { expect, test } from "bun:test";
import { WorkspaceSummaryLease, type WorkspaceSummaryScheduler, type WorkspaceSummaryTimer } from "../src/workspace-summary.js";

type Scheduled = { callback: () => void; delayMs: number; active: boolean };

class ManualScheduler implements WorkspaceSummaryScheduler {
  readonly scheduled: Scheduled[] = [];

  setTimeout(callback: () => void, delayMs: number): WorkspaceSummaryTimer {
    const scheduled = { callback, delayMs, active: true };
    this.scheduled.push(scheduled);
    return scheduled as unknown as WorkspaceSummaryTimer;
  }

  clearTimeout(timer: WorkspaceSummaryTimer): void {
    (timer as unknown as Scheduled).active = false;
  }

  fireNext(): boolean {
    const scheduled = this.scheduled.find(candidate => candidate.active);
    if (!scheduled) return false;
    scheduled.active = false;
    scheduled.callback();
    return true;
  }

  get active(): Scheduled[] {
    return this.scheduled.filter(candidate => candidate.active);
  }
}

const flush = () => new Promise<void>(resolve => queueMicrotask(resolve));

test("workspace lease publishes immediately and waits for completion before scheduling its heartbeat", async () => {
  const scheduler = new ManualScheduler();
  const summaries: string[] = [];
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async summary => { summaries.push(summary); } }, scheduler, 10);

  lease.update("idle");
  lease.start();
  await flush();

  expect(summaries).toEqual(["idle"]);
  expect(scheduler.active).toHaveLength(1);
  expect(scheduler.active[0]?.delayMs).toBe(10);
});

test("workspace lease schedules the next heartbeat only after a stalled publication completes", async () => {
  const scheduler = new ManualScheduler();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async () => { await gate; } }, scheduler, 10);

  lease.update("idle");
  lease.start();
  await flush();
  expect(scheduler.active).toHaveLength(0);

  release();
  await flush();
  expect(scheduler.active).toHaveLength(1);
  expect(scheduler.active[0]?.delayMs).toBe(10);
});

test("workspace lease recovers from a failed publication on its next heartbeat", async () => {
  const scheduler = new ManualScheduler();
  const summaries: string[] = [];
  let attempts = 0;
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async summary => {
    summaries.push(summary);
    attempts += 1;
    if (attempts === 1) throw new Error("unavailable");
  } }, scheduler, 10);

  lease.update("idle");
  lease.start();
  await flush();
  expect(scheduler.active).toHaveLength(1);

  expect(scheduler.fireNext()).toBe(true);
  await flush();
  expect(summaries).toEqual(["idle", "idle"]);
  expect(scheduler.active).toHaveLength(1);
});

test("workspace lease uses the latest summary on a later heartbeat", async () => {
  const scheduler = new ManualScheduler();
  const summaries: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async summary => {
    summaries.push(summary);
    if (summaries.length === 1) await gate;
  } }, scheduler, 10);

  lease.update("idle");
  lease.start();
  await flush();
  lease.update("working");
  release();
  await flush();
  expect(scheduler.fireNext()).toBe(true);
  await flush();

  expect(summaries).toEqual(["idle", "working"]);
});

test("workspace lease never overlaps publications", async () => {
  const scheduler = new ManualScheduler();
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await gate;
    active -= 1;
  } }, scheduler, 10);

  lease.update("idle");
  lease.start();
  await flush();
  lease.start();
  expect(scheduler.fireNext()).toBe(false);
  expect(maximum).toBe(1);

  release();
  await flush();
  expect(scheduler.fireNext()).toBe(true);
  await flush();
  expect(maximum).toBe(1);
});

test("stopping a workspace lease fences an in-flight publication from rescheduling", async () => {
  const scheduler = new ManualScheduler();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async () => { await gate; } }, scheduler, 10);

  lease.update("idle");
  lease.start();
  await flush();
  lease.stop();
  release();
  await flush();

  expect(scheduler.active).toHaveLength(0);
  expect(scheduler.fireNext()).toBe(false);
});

test("a stop-then-restart rolls generation while the old publication remains in flight", async () => {
  const scheduler = new ManualScheduler();
  const published: string[] = [];
  let releaseOld!: () => void;
  const oldGate = new Promise<void>(resolve => { releaseOld = resolve; });
  const lease = new WorkspaceSummaryLease({ workspaceMainSummary: async summary => {
    published.push(summary);
    if (summary === "old") await oldGate;
  } }, scheduler, 10);

  lease.update("old");
  lease.start();
  await flush();
  lease.stop();
  lease.update("new");
  lease.start();
  expect(published).toEqual(["old"]);

  releaseOld();
  await flush();
  await flush();
  expect(published).toEqual(["old", "new"]);
  expect(scheduler.active).toHaveLength(1);
  expect(scheduler.active[0]?.delayMs).toBe(10);
});
