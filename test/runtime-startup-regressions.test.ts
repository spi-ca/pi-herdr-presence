import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createPresenceProducer } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { PresenceRuntime, type LongRunningScheduler } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
type Listener = (payload: unknown) => void;

const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"] as const;
const pause = (milliseconds = 30) => new Promise(resolve => setTimeout(resolve, milliseconds));
let previous = Promise.resolve();
function serial(name: string, body: () => Promise<void>) {
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  const prior = previous;
  previous = mine;
  test(name, async () => {
    await prior;
    try { await body(); } finally { release(); }
  });
}

function makeBus() {
  const listeners = new Map<string, Listener[]>();
  return {
    getAllTools: () => [] as unknown[],
    on() {},
    events: {
      on(name: string, listener: Listener) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      emit(name: string, payload: unknown) { for (const listener of listeners.get(name) ?? []) listener(payload); },
    },
  };
}

function restore(saved: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function activeContext(runtime: PresenceRuntime) {
  return { sessionManager: (runtime as unknown as { sessionManager: unknown }).sessionManager };
}

class ManualLongRunningScheduler implements LongRunningScheduler {
  private time = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { due: number; callback: () => void }>();

  now() { return this.time; }
  setTimeout(callback: () => void, delayMs: number) {
    const id = ++this.nextId;
    this.timers.set(id, { due: this.time + delayMs, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>) {
    this.timers.delete(timer as unknown as number);
  }
  advance(milliseconds: number) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.due <= target)
        .sort(([, left], [, right]) => left.due - right.due)[0];
      if (!next) break;
      const [id, timer] = next;
      this.timers.delete(id);
      this.time = timer.due;
      timer.callback();
    }
    this.time = target;
  }
}

serial("a live edge during the stalled initial report gets latest metadata before its one notification", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-initial-projection-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenReport;
    expect(producer.activate()).toBe(true);
    expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
    releaseReport();
    await starting;
    await pause(100);

    const noticeIndex = requests.findIndex(request => request.method === "notification.show");
    const metadataIndex = requests.findIndex(request => request.method === "pane.report_metadata"
      && (request.params.tokens as Record<string, string | null>).v2_attention === "blocked:new");
    expect(noticeIndex).toBeGreaterThan(metadataIndex);
    expect(requests.filter(request => request.method === "notification.show")).toHaveLength(1);
  } finally {
    releaseReport?.();
    producer.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup correlation preserves accepted times rather than its delayed drain time", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-failure-correlation-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenReport;
    expect(producer.activate()).toBe(true);
    producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } });
    await pause(20);
    producer.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" });
    // The output gate remains closed longer than the correlation horizon.
    await pause(120);
    releaseReport();
    await starting;
    await pause(40);
    expect(requests.filter(request => request.method === "notification.show")).toHaveLength(1);
  } finally {
    releaseReport?.();
    producer.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("an acknowledged session authority is priority-cleared after startup projection expiry", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-authority-rollback-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let markProjection!: () => void;
  let markAuthorityClear!: () => void;
  const projectionSeen = new Promise<void>(resolve => { markProjection = resolve; });
  const authorityClearSeen = new Promise<void>(resolve => { markAuthorityClear = resolve; });
  const server = await fakeSocket(socket, line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { markProjection(); return undefined; }
    if (request.method === "pane.clear_agent_authority") markAuthorityClear();
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, timeoutMs: 200, finalClearMs: 1_000 });
  const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession(context);
    await projectionSeen;
    await starting;
    await Promise.race([
      authorityClearSeen,
      pause(1_000).then(() => { throw new Error("acknowledged authority was not cleared after startup expiry"); }),
    ]);

    const sessionIndex = requests.findIndex(request => request.method === "pane.report_agent_session");
    const projectionIndex = requests.findIndex(request => request.method === "pane.report_agent");
    const clearIndex = requests.findIndex(request => request.method === "pane.clear_agent_authority");
    expect(sessionIndex).toBeGreaterThan(-1);
    expect(projectionIndex).toBeGreaterThan(sessionIndex);
    expect(clearIndex).toBeGreaterThan(projectionIndex);
  } finally {
    await runtime.shutdownSession(context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("a pending native prompt is adopted after delayed TUI startup with one fixed notification", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-native-prompt-startup-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  const server = await fakeSocket(socket, line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const sessionContext = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession(sessionContext);
    // startSession records an exact TUI identity before its asynchronous probe.
    runtime.handleUiPromptStart(sessionContext);
    expect((runtime as unknown as { pendingLifecycle: { nativePromptWaiting: boolean } | null }).pendingLifecycle?.nativePromptWaiting).toBe(true);
    await starting;
    await pause();
    expect(requests.some(request => request.method === "pane.report_agent" && request.params.state === "blocked" && request.params.message === "Pi needs your input")).toBe(true);
    expect(requests.filter(request => request.method === "notification.show").map(request => request.params)).toEqual([
      expect.objectContaining({ title: "Pi needs your input", body: "Pi needs your input" }),
    ]);
  } finally {
    await runtime.shutdownSession(sessionContext);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("pending native prompts are discarded on replacement and shutdown", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-native-prompt-fence-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  const server = await fakeSocket(socket, line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const first = { mode: "tui", sessionManager: { getSessionId: () => "first" } };
  const replacement = { mode: "tui", sessionManager: { getSessionId: () => "replacement" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const firstStart = runtime.startSession(first);
    runtime.handleUiPromptStart(first);
    const replacementStart = runtime.startSession(replacement);
    await Promise.all([firstStart, replacementStart]);
    expect(requests.some(request => request.method === "pane.report_agent" && request.params.state === "idle")).toBe(true);
    expect(requests.some(request => request.method === "pane.report_agent" && request.params.state === "blocked")).toBe(false);
    expect(requests.some(request => request.method === "notification.show")).toBe(false);

    const shutdownStart = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "shutdown" } });
    const shutdownContext = { mode: "tui", sessionManager: (runtime as unknown as { pendingLifecycle: { manager: { getSessionId(): string } } | null }).pendingLifecycle?.manager };
    runtime.handleUiPromptStart(shutdownContext);
    await runtime.shutdownSession(shutdownContext);
    await shutdownStart;
    expect(requests.some(request => request.method === "notification.show")).toBe(false);
    expect((runtime as unknown as { pendingNotifications: unknown[]; inputLifecycles: unknown[] }).pendingNotifications).toEqual([]);
    expect((runtime as unknown as { inputLifecycles: unknown[] }).inputLifecycles).toEqual([]);
    expect("inputNotificationTimer" in (runtime as object)).toBe(false);
  } finally {
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup replay projects nested Todo counts but leaves handled child failures to the parent result", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-nested-tools-"));
  const socket = join(directory, "socket");
  let releaseReport!: () => void;
  let reportSeen!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  bus.getAllTools = () => [{ name: "todo", sourceInfo: { path: "/todo", source: "project", scope: "project", origin: "top" } }];
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), finalClearMs: 1_000 });
  const context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "root" } };
  const todo = { type: "tool_result", toolName: "todo", toolCallId: "parent/1", parentToolCallId: "parent", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "completed", subject: "PRIVATE_TASK" }] } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession(context);
    await seenReport;
    runtime.handleAgentStart(context);
    runtime.handleToolResult(todo, context);
    runtime.handleToolResult({ ...todo, toolCallId: "parent/2", isError: true }, context);
    runtime.handleToolResult({ toolName: "codemode", toolCallId: "parent", isError: false }, context);
    runtime.handleAgentEnd({ messages: [{ stopReason: "toolUse" }] }, context);
    runtime.handleAgentSettled(context);
    runtime.handleAgentStart(context);
    runtime.handleToolResult({ ...todo, isError: true }, context);
    runtime.handleToolResult({ toolName: "codemode", toolCallId: "parent", isError: true }, context);
    runtime.handleAgentEnd({ messages: [{ stopReason: "toolUse" }] }, context);
    runtime.handleAgentSettled(context);
    const state = runtime as unknown as { pendingLifecycle: unknown; terminalRecords: unknown[]; lastTodoState: unknown; toolFailed: boolean };
    expect(JSON.stringify(state.pendingLifecycle)).not.toContain("PRIVATE_TASK");
    expect(JSON.stringify(state.pendingLifecycle)).not.toContain("parent/1");
    releaseReport();
    await starting;
    expect(state.lastTodoState).toMatchObject({ progress: { completed: 1, total: 1 } });
    expect(state.terminalRecords).toMatchObject([{ outcome: "completed" }, { outcome: "failed" }]);
    expect(state.toolFailed).toBe(true);
  } finally {
    releaseReport?.();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("a pending agent end during stalled startup preserves the active long-running timer", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-agent-end-timer-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  let reportSeen!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const clock = new ManualLongRunningScheduler();
  const runtime = new PresenceRuntime(
    bus as never,
    { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "background", longRunningMs: 20, finalClearMs: 1_000 },
    undefined,
    undefined,
    clock,
  );
  const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession(context);
    await seenReport;
    runtime.handleAgentStart(context);
    runtime.handleAgentEnd({}, context);
    releaseReport();
    await starting;

    const internal = runtime as unknown as { longRunningTimer: unknown; longRunningRemaining: number | null; longRunningArmedAt: number | null; terminalRecords: unknown[] };
    expect(internal.longRunningTimer).not.toBeUndefined();
    expect(internal.longRunningRemaining).toBe(20);
    expect(internal.longRunningArmedAt).toBe(0);
    expect(internal.terminalRecords).toHaveLength(0);
    clock.advance(19);
    expect(requests.filter(request => request.method === "notification.show" && request.params.title === "Pi is still working")).toHaveLength(0);
    clock.advance(1);
    await pause();
    expect(requests.filter(request => request.method === "notification.show" && request.params.title === "Pi is still working")).toHaveLength(1);
    runtime.handleAgentSettled({ ...context, isIdle: () => true });
    expect(internal.terminalRecords).toHaveLength(1);
    expect(internal.longRunningTimer).toBeUndefined();
    expect(internal.longRunningRemaining).toBeNull();
    expect(internal.longRunningArmedAt).toBeNull();
  } finally {
    releaseReport?.();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("a stalled startup workspace read cannot delay pending notifications, lifecycle replay, or shutdown", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-workspace-order-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  let releaseList!: () => void;
  let reportSeen!: () => void;
  let listSeen!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const seenList = new Promise<void>(resolve => { listSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent" && requests.filter(candidate => candidate.method === "pane.report_agent").length === 1) { reportSeen(); await reportGate; }
    if (request.method === "pane.list") { listSeen(); await listGate; }
    return JSON.stringify({ id: request.id, result: request.method === "pane.list" ? { type: "pane_list", panes: [] } : {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  const sessionContext = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession(sessionContext);
    await seenReport;
    expect(producer.activate()).toBe(true);
    expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
    // This arrives while startup output is closed and must replay before the
    // observer-only workspace read begins.
    runtime.handleAgentStart(sessionContext);
    releaseReport();
    await starting;
    await seenList;

    const notificationIndex = requests.findIndex(request => request.method === "notification.show");
    const lifecycleIndex = requests.findIndex((request, index) => index > 0 && request.method === "pane.report_agent");
    const workspaceListIndex = requests.findIndex(request => request.method === "pane.list");
    expect(notificationIndex).toBeGreaterThan(-1);
    expect(notificationIndex).toBeLessThan(workspaceListIndex);
    expect(lifecycleIndex).toBeGreaterThan(-1);
    expect(lifecycleIndex).toBeLessThan(workspaceListIndex);
    expect((runtime as unknown as { active: boolean }).active).toBe(true);
    await Promise.race([
      runtime.shutdownSession(sessionContext),
      pause(200).then(() => { throw new Error("shutdown waited for the stalled workspace read"); }),
    ]);
  } finally {
    releaseReport?.();
    releaseList?.();
    producer.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("reload-active startup publishes running before a stalled workspace lease and still shuts down", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-reload-active-workspace-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseList!: () => void;
  let listSeen!: () => void;
  const listGate = new Promise<void>(resolve => { releaseList = resolve; });
  const seenList = new Promise<void>(resolve => { listSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.list") {
      listSeen();
      await listGate;
      return JSON.stringify({ id: request.id, result: { type: "pane_list", panes: [] } });
    }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, finalClearMs: 1_000 });
  const sessionContext = { mode: "tui", isIdle: () => false, sessionManager: { getSessionId: () => "root" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    await Promise.race([
      runtime.startSession(sessionContext),
      pause(200).then(() => { throw new Error("startSession waited for the workspace lease"); }),
    ]);
    await seenList;

    const runningIndex = requests.findIndex(request => request.method === "pane.report_agent" && request.params.state === "working");
    const workspaceListIndex = requests.findIndex(request => request.method === "pane.list");
    expect(runningIndex).toBeGreaterThan(-1);
    expect(runningIndex).toBeLessThan(workspaceListIndex);
    expect((runtime as unknown as { active: boolean }).active).toBe(true);
    await Promise.race([
      runtime.shutdownSession(sessionContext),
      pause(200).then(() => { throw new Error("shutdown waited for the workspace lease"); }),
    ]);
  } finally {
    releaseList?.();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup projections reach a fixed point before terminal retention and notification release", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-fixed-point-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  let releaseCatchup!: () => void;
  const catchupGate = new Promise<void>(resolve => { releaseCatchup = resolve; });
  let firstSeen!: () => void;
  const seenFirst = new Promise<void>(resolve => { firstSeen = resolve; });
  let catchupSeen!: () => void;
  const seenCatchup = new Promise<void>(resolve => { catchupSeen = resolve; });
  let reports = 0;
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") {
      reports += 1;
      if (reports === 1) { firstSeen(); await firstGate; }
      else if (reports === 2) { catchupSeen(); await catchupGate; }
    }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1 });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenFirst;
    expect(producer.activate()).toBe(true);
    expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
    releaseFirst();
    await seenCatchup;
    expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "completed" })).toBe(true);
    // A terminal accepted during the catch-up pass must not expire while the
    // public projection gate is still closed, even with a very short TTL.
    await pause(30);
    releaseCatchup();
    await starting;
    await pause();

    // Semantic report dedupe retains the changed initial/blocked projections;
    // the terminal-only and final-idle passes do not resend unchanged agent state.
    expect(reports).toBe(2);
    const terminalMetadataIndex = requests.findIndex(request => request.method === "pane.report_metadata"
      && (request.params.tokens as Record<string, string | null>).v2_terminals === "subagent:1:1:completed");
    const notificationIndex = requests.findIndex(request => request.method === "notification.show" && request.params.title === "Pi activity completed");
    expect(terminalMetadataIndex).toBeGreaterThan(-1);
    expect(notificationIndex).toBeGreaterThan(terminalMetadataIndex);
  } finally {
    releaseFirst?.();
    releaseCatchup?.();
    producer.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("unchanged startup projections are suppressed before they can cause fixed-point churn", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-unstable-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let producer: ReturnType<typeof createPresenceProducer> | undefined;
  let projections = 0;
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") {
      projections += 1;
      producer?.publishState({ version: 2, generation: 1, sequence: projections, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } });
    }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit });
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    expect(producer?.activate()).toBe(true);
    registerPresenceHooks(bus as never, runtime);
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });

    // Each fixed-point pass is still evaluated, but identical wire projections
    // are acknowledged once and then suppressed by the ordinary report cache.
    expect(projections).toBe(2);
    expect((runtime as unknown as { rootSession: boolean; consumer: unknown; outputReady: boolean }).rootSession).toBe(true);
    expect((runtime as unknown as { rootSession: boolean; consumer: unknown; outputReady: boolean }).consumer).not.toBeNull();
    expect((runtime as unknown as { rootSession: boolean; consumer: unknown; outputReady: boolean }).outputReady).toBe(true);
    expect(requests.some(request => request.method === "notification.show")).toBe(false);
  } finally {
    producer?.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup notification drain preserves external candidate arrival order", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-notification-order-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenReport;
    expect(producer.activate()).toBe(true);
    expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
    expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "completed" })).toBe(true);
    releaseReport();
    await starting;
    // The legacy external coalescing timer would otherwise submit blocked after
    // the later completion. Startup's bounded deferred sequence is immediate.
    await pause(100);

    expect(requests.filter(request => request.method === "notification.show").map(request => request.params.title)).toEqual([
      "Pi needs attention",
      "Pi activity completed",
    ]);
  } finally {
    releaseReport?.();
    producer.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup native failure/input ordering remains bounded at maxQueue=1", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-pairing-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000, maxQueue: 1 });
  const subagent = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  const delayed = createPresenceProducer({ source: "pi", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    // Claim the external pi source before the runtime activates its local candidates.
    expect(delayed.activate()).toBe(true);
    registerPresenceHooks(bus as never, runtime);
    const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
    const starting = runtime.startSession(context);
    await seenReport;
    expect(subagent.activate()).toBe(true);
    subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } });
    runtime.handleUiPromptStart(context);
    // The failed terminal is a distinct edge; it must remain independent.
    subagent.publishTerminal({ version: 2, generation: 2, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" });
    delayed.publishState({ version: 2, generation: 1, sequence: 1, source: "pi", state: "error", attention: { reason: "failure", occurrence: "new" } });
    await pause(30);
    delayed.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "pi", eventId: 1, outcome: "failed" });
    delayed.publishTerminal({ version: 2, generation: 2, sequence: 1, source: "pi", eventId: 1, outcome: "completed" });
    releaseReport();
    await starting;
    await pause();

    // The native input suppresses only its nearby state failure. The distinct
    // failed terminal remains independently eligible under the smallest queue.
    expect(requests.filter(request => request.method === "notification.show").map(request => request.params.title)).toEqual([
      "Pi needs your input",
      "Pi needs attention",
    ]);
  } finally {
    releaseReport?.();
    for (const producer of [subagent, delayed]) producer.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup pre-dispatch input withdrawal cancels its stale alert and releases nearby failure fallback", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-input-ended-failure-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const interaction = createPresenceProducer({ source: "interaction", emit: bus.events.emit })!;
  const subagent = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
    const starting = runtime.startSession(context);
    await seenReport;
    expect(interaction.activate()).toBe(true);
    expect(subagent.activate()).toBe(true);
    interaction.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } });
    interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
    subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } });
    releaseReport();
    await starting;
    await pause(30);

    expect(requests.filter(request => request.method === "notification.show").map(request => request.params.title)).toEqual(["Pi needs attention"]);
    expect((runtime as unknown as { failureArrivals: unknown[]; inputLifecycles: unknown[] }).failureArrivals).toEqual([]);
    expect((runtime as unknown as { inputLifecycles: unknown[] }).inputLifecycles).toEqual([]);
  } finally {
    releaseReport?.();
    interaction.deactivate();
    subagent.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("startup rejected input lifecycle does not inherit an older admitted receipt", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-rejected-input-failure-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const interaction = createPresenceProducer({ source: "interaction", emit: bus.events.emit })!;
  const subagent = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const internal = runtime as unknown as { notify(severity: string, key: string, title: string, body: string, origin: "local" | "external", inputLifecycleId?: number | null): boolean };
    const notify = internal.notify.bind(runtime);
    let inputAttempts = 0;
    internal.notify = (severity, key, title, body, origin, inputLifecycleId) => severity === "attention" && ++inputAttempts > 1 ? false : notify(severity, key, title, body, origin, inputLifecycleId);
    const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
    const starting = runtime.startSession(context);
    await seenReport;
    expect(interaction.activate()).toBe(true);
    expect(subagent.activate()).toBe(true);
    interaction.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } });
    interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
    interaction.publishState({ version: 2, generation: 2, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } });
    interaction.withdraw({ version: 2, generation: 2, sequence: 2, source: "interaction" });
    subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } });
    releaseReport();
    await starting;
    await pause(30);

    // Both short prompts ended while their input requests were still queued;
    // neither stale toast reaches the socket, and the nearby failure stays live.
    expect(requests.filter(request => request.method === "notification.show").map(request => request.params.title)).toEqual(["Pi needs attention"]);
    expect((runtime as unknown as { failureArrivals: unknown[]; inputLifecycles: unknown[] }).failureArrivals).toEqual([]);
    expect((runtime as unknown as { inputLifecycles: unknown[] }).inputLifecycles).toEqual([]);
  } finally {
    releaseReport?.();
    interaction.deactivate();
    subagent.deactivate();
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("a root-session Todo reset lets an immediate pending lifecycle claim exactly one new owner", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-todo-boundary-"));
  const socket = join(directory, "socket");
  const server = await fakeSocket(socket, line => {
    const request = JSON.parse(line) as Request;
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  let tools: unknown[] = [];
  bus.getAllTools = () => tools;
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, finalClearMs: 1_000 });
  const result = { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "pending" }] } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const oldManager = { getSessionId: () => "old" };
    const oldContext = { mode: "tui", sessionManager: oldManager };
    tools = [{ name: "todo", sourceInfo: { path: "/old", source: "project", scope: "project", origin: "top" } }];
    await runtime.startSession(oldContext);
    runtime.handleToolResult(result, oldContext);

    const newManager = { getSessionId: () => "new" };
    const newContext = { mode: "tui", sessionManager: newManager };
    tools = [{ name: "todo", sourceInfo: { path: "/first-new", source: "project", scope: "project", origin: "top" } }];
    const starting = runtime.startSession(newContext);
    runtime.handleToolResult(result, newContext);
    await starting;
    const first = (runtime as unknown as { lastTodoState: unknown }).lastTodoState;
    expect(first).not.toBeNull();

    tools = [{ name: "todo", sourceInfo: { path: "/second-new", source: "project", scope: "project", origin: "top" } }];
    runtime.handleToolResult(result, newContext);
    expect((runtime as unknown as { lastTodoState: unknown }).lastTodoState).toBe(first);

    tools = [{ name: "todo", sourceInfo: { path: "/third-root", source: "project", scope: "project", origin: "top" } }];
    const thirdManager = { getSessionId: () => "third" };
    const thirdContext = { mode: "tui", sessionManager: thirdManager };
    await runtime.startSession(thirdContext);
    const beforeStale = (runtime as unknown as { lastTodoState: unknown }).lastTodoState;
    runtime.handleToolResult(result, oldContext);
    expect((runtime as unknown as { lastTodoState: unknown }).lastTodoState).toBe(beforeStale);
    runtime.handleToolResult(result, thirdContext);
    expect((runtime as unknown as { lastTodoState: unknown }).lastTodoState).not.toBeNull();
  } finally {
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("pending cancellation retains only a boolean and replays in order without a success notification", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-cancelled-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  let markCancelled!: () => void;
  const cancelledMetadata = new Promise<void>(resolve => { markCancelled = resolve; });
  const server = await fakeSocket(socket, line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    const tokens = request.params.tokens as Record<string, unknown> | undefined;
    if (request.method === "pane.report_metadata" && tokens?.summary === "idle · terminal cancelled" && String(tokens.v2_terminals).includes("pi:1:3:cancelled")) markCancelled();
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const hooks = new Map<string, (event: unknown, context: unknown) => unknown>();
  const pi = { ...bus, on(name: string, listener: (event: unknown, context: unknown) => unknown) { hooks.set(name, listener); } };
  const runtime = new PresenceRuntime(pi as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "root" } };
  const state = runtime as unknown as { pendingLifecycle: { edges: unknown[] } | null; terminalRecords: unknown[]; lastPiState: unknown; active: boolean; longRunningRemaining: number | null };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(pi as never, runtime);
    const starting = runtime.startSession(context);
    // Capture before any asynchronous probe can finish. Every replay edge is
    // derived now, not from a retained event payload or context abort signal.
    for (const window of ["tool", "retry", "compaction"] as const) {
      runtime.handleAgentStart(context);
      if (window === "tool") runtime.handleToolResult({ isError: true, content: [{ text: "PRIVATE_TOOL" }] }, context);
      runtime.handleAgentEnd({ messages: [{ stopReason: window === "tool" ? "toolUse" : window === "retry" ? "error" : "stop" }] }, context);
      const event = { type: "agent_settled", aborted: true, text: "PRIVATE_SETTLEMENT" };
      hooks.get("agent_settled")!(event, { ...context });
      event.aborted = false;
    }
    expect(state.pendingLifecycle?.edges.filter(edge => (edge as { kind: string }).kind === "agent_settled")).toEqual([
      { kind: "agent_settled", aborted: true }, { kind: "agent_settled", aborted: true }, { kind: "agent_settled", aborted: true },
    ]);
    expect(JSON.stringify(state.pendingLifecycle)).not.toContain("PRIVATE_");
    await starting;
    expect(state.active).toBe(false);
    expect(state.lastPiState).toMatchObject({ state: "cancelled" });
    expect(state.terminalRecords).toMatchObject([{ outcome: "cancelled" }, { outcome: "cancelled" }, { outcome: "cancelled" }]);
    expect(state.longRunningRemaining).toBeNull();
    await cancelledMetadata;
    expect(requests.filter(request => request.method === "notification.show")).toHaveLength(0);
    expect(requests.some(request => request.method === "pane.report_metadata" && (request.params.tokens as Record<string, unknown>).summary === "idle · terminal cancelled")).toBe(true);
    expect(JSON.stringify(requests)).not.toContain("PRIVATE_");
  } finally {
    await runtime.shutdownSession(context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

serial("replacement fences pending and stale aborted settlement while normal pending retry still completes", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-cancellation-fence-"));
  const socket = join(directory, "socket");
  const server = await fakeSocket(socket, line => {
    const request = JSON.parse(line) as Request;
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, finalClearMs: 1_000 });
  const stale = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "root" } };
  const current = { ...stale, sessionManager: { getSessionId: () => "root" } };
  const state = runtime as unknown as { pendingLifecycle: { edges: unknown[] } | null; terminalRecords: unknown[]; terminal: string; active: boolean };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const oldStart = runtime.startSession(stale);
    runtime.handleAgentStart(stale);
    runtime.handleAgentSettled(stale, true);
    const newStart = runtime.startSession(current);
    runtime.handleAgentStart(current);
    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] }, current);
    runtime.handleAgentSettled(stale, true);
    expect(state.pendingLifecycle?.edges).toHaveLength(2);
    runtime.handleAgentStart(current);
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] }, current);
    runtime.handleAgentSettled(current);
    await Promise.all([oldStart, newStart]);
    expect(state.terminalRecords).toMatchObject([{ outcome: "completed" }]);
    expect(state.terminal).toBe("success");
    expect(state.active).toBe(false);
    runtime.handleAgentSettled(stale, true);
    expect(state.terminal).toBe("success");
    expect(state.terminalRecords).toHaveLength(1);
  } finally {
    await runtime.shutdownSession(current);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
