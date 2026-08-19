import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createPresenceProducer } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { PresenceRuntime } from "../src/runtime.js";
import type { WorkspaceSummaryScheduler, WorkspaceSummaryTimer } from "../src/workspace-summary.js";
import { paneInfo } from "./fixtures/pane-info.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
type Scheduled = { callback: () => void; active: boolean };
const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"] as const;
const context = (id: string) => ({ mode: "tui", sessionManager: { getSessionId: () => id }, isIdle: () => true });
const restore = (saved: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

class ManualScheduler implements WorkspaceSummaryScheduler {
  readonly scheduled: Scheduled[] = [];

  setTimeout(callback: () => void): WorkspaceSummaryTimer {
    const scheduled = { callback, active: true };
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

async function until(condition: () => boolean) {
  const deadline = Date.now() + 1_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for socket request.");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function workspaceRuntime(name: string, handler: (request: Request) => string | Promise<string>, scheduler?: WorkspaceSummaryScheduler) {
  const directory = await fs.mkdtemp(join(os.tmpdir(), name));
  const socket = join(directory, "socket");
  const server = await fakeSocket(socket, async (line) => handler(JSON.parse(line) as Request));
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_WORKSPACE_ID: "workspace", HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "absent") });
  let runtime: PresenceRuntime | undefined;
  const events = { on() {}, emit(name: unknown, payload: unknown) { runtime?.handlePresenceEvent(name, payload); } };
  runtime = new PresenceRuntime({ getAllTools: () => [], events } as never, resolvePresenceConfig(), scheduler);
  return { directory, runtime, server, saved };
}

test("runtime publishes immediately, refreshes through its lease timer, and stops the timer on teardown", async () => {
  const requests: Request[] = [];
  const scheduler = new ManualScheduler();
  const fixture = await workspaceRuntime("herdr-workspace-heartbeat-", (request) => {
    requests.push(request);
    return JSON.stringify({ id: request.id, result: request.method === "pane.list" ? { type: "pane_list", panes: [paneInfo()] } : { type: "ok" } });
  }, scheduler);
  const { runtime } = fixture;
  const sessionContext = context("session");
  try {
    await runtime.startSession(sessionContext);
    await until(() => requests.some(request => request.method === "workspace.report_metadata"));
    expect(requests.filter(request => request.method === "workspace.report_metadata").at(-1)?.params.tokens).toEqual({ main_summary: "idle" });
    expect(scheduler.active).toHaveLength(1);

    runtime.handleAgentStart(sessionContext);
    await until(() => requests.some(request => request.method === "pane.report_metadata" && (request.params.tokens as Record<string, string | null>).summary === "working"));
    expect(scheduler.fireNext()).toBe(true);
    await until(() => (requests.filter(request => request.method === "workspace.report_metadata").at(-1)?.params.tokens as Record<string, string> | undefined)?.main_summary === "working");

    await runtime.shutdownSession(sessionContext);
    const workspaceCount = requests.filter(request => request.method === "workspace.report_metadata").length;
    expect(scheduler.active).toHaveLength(0);
    expect(scheduler.fireNext()).toBe(false);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(workspaceCount);
  } finally {
    await runtime.shutdownSession(sessionContext);
    restore(fixture.saved);
    await fixture.server.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("terminal metadata supplies the latest summary to the next workspace lease heartbeat", async () => {
  const requests: Request[] = [];
  const scheduler = new ManualScheduler();
  let terminalMetadataSeen!: () => void;
  const terminalMetadata = new Promise<void>(resolve => { terminalMetadataSeen = resolve; });
  const fixture = await workspaceRuntime("herdr-workspace-terminal-summary-", (request) => {
    requests.push(request);
    const tokens = request.params.tokens as Record<string, string | null> | undefined;
    if (request.method === "pane.report_metadata" && tokens?.summary === "idle · terminal completed") terminalMetadataSeen();
    return JSON.stringify({ id: request.id, result: request.method === "pane.list" ? { type: "pane_list", panes: [paneInfo()] } : { type: "ok" } });
  }, scheduler);
  const { runtime } = fixture;
  const sessionContext = context("session");
  const producer = createPresenceProducer({ source: "subagent", emit: (name: unknown, payload: unknown) => runtime.handlePresenceEvent(name, payload) })!;
  try {
    await runtime.startSession(sessionContext);
    await until(() => requests.some(request => request.method === "workspace.report_metadata"));
    expect(scheduler.active).toHaveLength(1);
    expect(producer.activate()).toBe(true);
    expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "completed" })).toBe(true);
    await terminalMetadata;

    expect(requests.filter(request => request.method === "pane.report_metadata").at(-1)?.params.tokens).toMatchObject({ summary: "idle · terminal completed", v2_terminals: "subagent:1:1:completed" });
    expect(scheduler.fireNext()).toBe(true);
    await until(() => (requests.filter(request => request.method === "workspace.report_metadata").at(-1)?.params.tokens as Record<string, string> | undefined)?.main_summary === "idle · terminal completed");
  } finally {
    producer.deactivate();
    await runtime.shutdownSession(sessionContext);
    restore(fixture.saved);
    await fixture.server.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("replacement fences a stalled workspace list before it can write", async () => {
  const requests: Request[] = [];
  let listCalls = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstSeen!: () => void;
  let secondSeen!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const seenFirst = new Promise<void>(resolve => { firstSeen = resolve; });
  const seenSecond = new Promise<void>(resolve => { secondSeen = resolve; });
  const fixture = await workspaceRuntime("herdr-workspace-replacement-fence-", async (request) => {
    requests.push(request);
    if (request.method === "pane.list") {
      listCalls += 1;
      if (listCalls === 1) { firstSeen(); await firstGate; }
      if (listCalls === 2) { secondSeen(); await secondGate; }
      return JSON.stringify({ id: request.id, result: { type: "pane_list", panes: [paneInfo()] } });
    }
    return JSON.stringify({ id: request.id, result: { type: "ok" } });
  });
  const { runtime } = fixture;
  const firstContext = context("first");
  const secondContext = context("second");
  try {
    const initial = runtime.startSession(firstContext);
    await seenFirst;
    const replacement = runtime.startSession(secondContext);
    releaseFirst();
    await seenSecond;
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(0);
    releaseSecond();
    await Promise.all([initial, replacement]);
    await until(() => requests.filter(request => request.method === "workspace.report_metadata").length === 1);
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(1);
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    await runtime.shutdownSession(secondContext);
    restore(fixture.saved);
    await fixture.server.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("valid shutdown fences a lease-timer workspace list before it can write", async () => {
  const requests: Request[] = [];
  const scheduler = new ManualScheduler();
  let listCalls = 0;
  let release!: () => void;
  let stalled!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seenStalled = new Promise<void>(resolve => { stalled = resolve; });
  const fixture = await workspaceRuntime("herdr-workspace-shutdown-fence-", async (request) => {
    requests.push(request);
    if (request.method === "pane.list") {
      listCalls += 1;
      if (listCalls === 2) { stalled(); await gate; }
      return JSON.stringify({ id: request.id, result: { type: "pane_list", panes: [paneInfo()] } });
    }
    return JSON.stringify({ id: request.id, result: { type: "ok" } });
  }, scheduler);
  const { runtime } = fixture;
  const sessionContext = context("session");
  try {
    await runtime.startSession(sessionContext);
    await until(() => requests.some(request => request.method === "workspace.report_metadata"));
    const reportsBefore = requests.filter(request => request.method === "workspace.report_metadata").length;
    expect(scheduler.fireNext()).toBe(true);
    await seenStalled;
    const shutdown = runtime.shutdownSession(sessionContext);
    release();
    await shutdown;
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(reportsBefore);
    expect(scheduler.active).toHaveLength(0);
  } finally {
    release?.();
    await runtime.shutdownSession(sessionContext);
    restore(fixture.saved);
    await fixture.server.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});
