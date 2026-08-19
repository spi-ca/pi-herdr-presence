import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createPresenceProducer } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { PresenceRuntime } from "../src/runtime.js";
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

    // Initial, first catch-up, and terminal catch-up projections are distinct;
    // the final local idle publication occurs only after startup stabilization.
    expect(reports).toBe(4);
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

serial("an unstable startup projection tears down without releasing notifications", async () => {
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

    expect(projections).toBe(16);
    expect((runtime as unknown as { rootSession: boolean; consumer: unknown; outputReady: boolean }).rootSession).toBe(false);
    expect((runtime as unknown as { rootSession: boolean; consumer: unknown; outputReady: boolean }).consumer).toBeNull();
    expect((runtime as unknown as { rootSession: boolean; consumer: unknown; outputReady: boolean }).outputReady).toBe(false);
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

serial("startup failure pairing uses acceptance time and preserves unpaired candidate order", async () => {
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
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const input = createPresenceProducer({ source: "interaction", emit: bus.events.emit })!;
  const subagent = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  const delayed = createPresenceProducer({ source: "pi", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    // Claim the external pi source before the runtime activates its local candidates.
    expect(delayed.activate()).toBe(true);
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenReport;
    for (const producer of [input, subagent]) expect(producer.activate()).toBe(true);
    input.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } });
    subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } });
    subagent.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" });
    delayed.publishState({ version: 2, generation: 1, sequence: 1, source: "pi", state: "error", attention: { reason: "failure", occurrence: "new" } });
    await pause(30);
    delayed.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "pi", eventId: 1, outcome: "failed" });
    delayed.publishTerminal({ version: 2, generation: 2, sequence: 1, source: "pi", eventId: 1, outcome: "completed" });
    releaseReport();
    await starting;
    await pause();

    expect(requests.filter(request => request.method === "notification.show").map(request => request.params.title)).toEqual([
      "Pi needs your input",
      "Pi needs attention",
      "Pi needs attention",
      "Pi needs attention",
      "Pi activity completed",
    ]);
  } finally {
    releaseReport?.();
    for (const producer of [input, subagent, delayed]) producer.deactivate();
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
