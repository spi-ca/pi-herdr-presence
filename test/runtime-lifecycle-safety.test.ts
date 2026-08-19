import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createPresenceConsumer, createPresenceProducer, EVENT_NAMES, MAX_INTEGER } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";
import { expectExactLegacyMetadataClear, expectExactMetadataClear, expectExactMetadataIngress } from "./fixtures/metadata-ingress.js";

type Listener = (payload: unknown) => void;
type LifecycleListener = (event: unknown, context: unknown) => unknown;
type Bus = {
  getAllTools(): unknown[];
  on(name: string, listener: LifecycleListener): void;
  hooks: Map<string, LifecycleListener[]>;
  events: { on(name: string, listener: Listener): void; emit(name: string, payload: unknown): void };
};
type InternalRuntime = {
  client: { teardown(timeoutMs: number): Promise<void> } | null;
  consumer: ReturnType<typeof createPresenceConsumer> | null;
  consumerReady: unknown;
  consumerActive: boolean;
  localPi: unknown;
  localTodo: unknown;
  localPiActive: boolean;
  localTodoActive: boolean;
  rootSession: boolean;
  pendingLifecycle: { edges: unknown[]; overflow: boolean } | null;
  sessionManager: { getSessionId?: () => unknown } | null;
  ingressEpoch: number | null;
  generation: number;
  sequence: number;
  handleConsumerReady(payload: unknown): void;
  terminal: string;
  mode: "standalone" | "companion" | "disabled";
  active: boolean;
  terminalRecords: unknown[];
  lastPiState: { state?: string; attention?: { reason?: string } } | null;
  toolFailed: boolean;
  lastTodoState: unknown;
  usage: { snapshot(): unknown };
};

const pause = (milliseconds = 80) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"] as const;

function makeBus(): Bus {
  const listeners = new Map<string, Listener[]>();
  const hooks = new Map<string, LifecycleListener[]>();
  return {
    getAllTools() { return []; },
    hooks,
    on(name, listener) {
      const current = hooks.get(name) ?? [];
      current.push(listener);
      hooks.set(name, current);
    },
    events: {
      on(name, listener) {
        const current = listeners.get(name) ?? [];
        current.push(listener);
        listeners.set(name, current);
      },
      emit(name, payload) {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
      },
    },
  };
}

function restore(saved: Record<string, string | undefined>) {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withRuntime(
  run: (runtime: PresenceRuntime, bus: Bus, requests: Array<{ method: string; params: Record<string, unknown> }>) => Promise<void>,
  config = { ...resolvePresenceConfig(), soleReporter: true },
  bus = makeBus(),
) {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-lifecycle-v2-"));
  const socket = join(directory, "socket");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const runtime = new PresenceRuntime(bus as never, { ...config, finalClearMs: 0 });
  registerPresenceHooks(bus as never, runtime);
  try {
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socket,
      HERDR_PANE_ID: "pane",
      PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir"),
    });
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await run(runtime, bus, requests);
  } finally {
    await runtime.shutdownSession(activeContext(runtime));
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const internal = (runtime: PresenceRuntime) => runtime as unknown as InternalRuntime;
const activeContext = (runtime: PresenceRuntime) => ({ sessionManager: internal(runtime).sessionManager ?? undefined });
const agentRequests = (requests: Array<{ method: string; params: Record<string, unknown> }>) => requests.filter((request) => request.method === "pane.report_agent");

test("root and TUI gating leave no V2 consumer outside a root TUI session", async () => {
  const runtime = new PresenceRuntime(makeBus() as never, { ...resolvePresenceConfig(), soleReporter: true });

  await runtime.startSession({ mode: "cli", sessionManager: { getSessionId: () => "root" } });
  expect(internal(runtime).consumer).toBeNull();
  await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "" } });
  expect(internal(runtime).consumer).toBeNull();
  await runtime.shutdownSession((runtime as unknown as { context: object }).context);
});

test("a managed official integration selects companion presentation mode", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-managed-v2-"));
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    await fs.mkdir(join(directory, "extensions"));
    await fs.writeFile(join(directory, "extensions", "herdr-agent-state.ts"), "HERDR_INTEGRATION_ID=pi");
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: join(directory, "no-socket"),
      HERDR_PANE_ID: "pane",
      PI_CODING_AGENT_DIR: directory,
    });
    const runtime = new PresenceRuntime(makeBus() as never, { ...resolvePresenceConfig(), soleReporter: true });
    const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
    await runtime.startSession(context);

    expect(internal(runtime).consumer).not.toBeNull();
    expect(internal(runtime).mode).toBe("companion");
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
  } finally {
    restore(saved);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("unknown managed-hook startup stays disabled", async () => {
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/tmp/herdr-presence-no-socket",
      HERDR_PANE_ID: "pane",
      // Relative configured roots are deliberately ambiguous and fail closed.
      PI_CODING_AGENT_DIR: "ambiguous-relative-root",
    });
    const runtime = new PresenceRuntime(makeBus() as never, { ...resolvePresenceConfig(), soleReporter: true });
    const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
    await runtime.startSession(context);
    expect(internal(runtime).consumer).toBeNull();
  } finally { restore(saved); }
});

test("an absent managed file automatically activates standalone mode", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-absent-default-v2-"));
  const socket = join(directory, "socket");
  const server = await fakeSocket(socket, () => "");
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socket,
      HERDR_PANE_ID: "pane",
      PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir"),
    });
    const runtime = new PresenceRuntime(makeBus() as never, resolvePresenceConfig());
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    expect(internal(runtime).consumer).not.toBeNull();
    expect(internal(runtime).rootSession).toBe(true);
    expect(internal(runtime).mode).toBe("standalone");
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
  } finally {
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("runtime keeps safe pane messages separate from presentation and ten-token metadata", async () => {
  await withRuntime(async (_runtime, _bus, requests) => {
    await pause();
    const metadata = requests.filter((request) => request.method === "pane.report_metadata");
    expect(metadata.length).toBeGreaterThan(2);
    expectExactMetadataClear(metadata[0]!.params);
    expectExactLegacyMetadataClear(metadata[1]!.params);
    for (const request of metadata.slice(2)) expectExactMetadataIngress(request.params);
    expect(agentRequests(requests).some((request) => request.params.message === "Pi is idle")).toBe(true);
  });
});

test("a valid waiting plus blocked V2 fixture projects fixed blocked pane presentation", async () => {
  await withRuntime(async (_runtime, bus, requests) => {
    const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
    expect(producer.activate()).toBe(true);
    try {
      expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
      await pause();
      const report = agentRequests(requests).at(-1);
      expect(report?.params).toMatchObject({ state: "blocked", message: "Pi needs attention" });
      const ingress = requests.filter((request) => request.method === "pane.report_metadata" && "title" in request.params).at(-1);
      expect(ingress).toBeDefined();
      if (!ingress) throw new Error("missing metadata ingress");
      expectExactMetadataIngress(ingress.params);
      expect((ingress.params.tokens as Record<string, unknown>).v2_attention).toBe("blocked:new");
    } finally {
      producer.deactivate();
    }
  }, { ...{ ...resolvePresenceConfig(), soleReporter: true }, notificationPolicy: "disabled" });
});

test("metadata-disabled startup still clears stale ownership before reporting session authority", async () => {
  await withRuntime(async (_runtime, _bus, requests) => {
    await pause();
    const metadata = requests.filter((request) => request.method === "pane.report_metadata");
    expect(metadata).toHaveLength(2);
    expectExactMetadataClear(metadata[0]!.params);
    expectExactLegacyMetadataClear(metadata[1]!.params);
    expect(requests.findIndex((request) => request.method === "pane.report_agent_session")).toBeGreaterThan(1);
  }, { ...{ ...resolvePresenceConfig(), soleReporter: true }, metadata: false });
});

test("agent_start refreshes only the session ID and never projects the session file path", async () => {
  await withRuntime(async (runtime, _bus, requests) => {
    runtime.handleAgentStart(activeContext(runtime));
    await pause();

    const reports = requests.filter((request) => request.method === "pane.report_agent_session");
    expect(reports.at(-1)?.params).toMatchObject({ agent_session_id: "root" });
    expect(JSON.stringify(requests)).not.toContain("/private/sessions/root.jsonl");
    expect(requests.every((request) => !("agent_session_path" in request.params))).toBe(true);
  });
});

test("late context lifecycle callbacks from a prior session cannot mutate the active session", async () => {
  await withRuntime(async (runtime, _bus, requests) => {
    const prior = { sessionManager: { getSessionId: () => "root" }, isIdle: () => true, getContextUsage: () => ({ percent: 99 }) };
    const current = { mode: "tui", sessionManager: { getSessionId: () => "next" }, isIdle: () => true, getContextUsage: () => ({ percent: 1 }) };
    await runtime.startSession(current);
    const firstCurrentRequest = requests.length;
    const state = runtime as unknown as { active: boolean; context: unknown; sessionId: string | null };
    expect(state.sessionId).toBe("next");

    runtime.handleAgentStart(prior);
    runtime.handleTurnStart(prior);
    expect(state.active).toBe(false);
    expect(state.context).toBe(current);

    runtime.handleAgentStart(current);
    expect(state.active).toBe(true);
    runtime.handleAgentSettled(prior);
    expect(state.active).toBe(true);
    await pause();
    expect(agentRequests(requests.slice(firstCurrentRequest)).every((request) => request.params.agent_session_id === "next")).toBe(true);
  });
});

test("fresh event wrappers sharing the session_start manager and ID drive the lifecycle", async () => {
  await withRuntime(async (runtime, bus, requests) => {
    const manager = { getSessionId: () => "root" };
    await runtime.startSession({ mode: "tui", sessionManager: manager, isIdle: () => true });
    const fresh = { sessionManager: manager, isIdle: () => true, getContextUsage: () => ({ percent: 42 }) };
    const hook = (name: string, event: unknown) => bus.hooks.get(name)?.[0]?.(event, fresh);

    await hook("agent_start", { type: "agent_start" });
    await hook("turn_start", { type: "turn_start" });
    expect(internal(runtime).active).toBe(true);
    expect((runtime as unknown as { context: object }).context).toBe(fresh);
    await hook("agent_end", { messages: [{ stopReason: "stop" }] });
    await hook("agent_settled", { type: "agent_settled" });

    expect(internal(runtime).active).toBe(false);
    expect(internal(runtime).usage.snapshot()).toMatchObject({ contextPercent: 42 });
    expect(agentRequests(requests).every(request => request.params.agent_session_id === "root")).toBe(true);
  });
});

test("a new root session accepts a distinct Todo owner while stale callbacks stay fenced", async () => {
  const bus = makeBus();
  let tools: unknown[] = [{ name: "todo", sourceInfo: { path: "/session-a/todo", source: "project", scope: "project", origin: "top" } }];
  bus.getAllTools = () => tools;
  const todoResult = { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "pending" }] } };
  await withRuntime(async (runtime) => {
    const managerA = internal(runtime).sessionManager!;
    const contextA = { sessionManager: managerA };
    runtime.handleToolResult(todoResult, contextA);
    expect(internal(runtime).lastTodoState).toMatchObject({ source: "todo", generation: 1 });

    await runtime.shutdownSession(contextA);
    tools = [{ name: "todo", sourceInfo: { path: "/session-b/todo", source: "project", scope: "project", origin: "top" } }];
    const managerB = { getSessionId: () => "session-b" };
    await runtime.startSession({ mode: "tui", sessionManager: managerB });
    const beforeStale = internal(runtime).lastTodoState;
    runtime.handleToolResult(todoResult, contextA);
    expect(internal(runtime).lastTodoState).toBe(beforeStale);
    runtime.handleToolResult(todoResult, { sessionManager: managerB });
    expect(internal(runtime).lastTodoState).toMatchObject({ source: "todo", generation: 2 });
  }, { ...resolvePresenceConfig(), soleReporter: true }, bus);
});

test("a stale manager with the same ID cannot mutate or shut down its replacement", async () => {
  await withRuntime(async (runtime) => {
    const staleManager = { getSessionId: () => "root" };
    const activeManager = { getSessionId: () => "root" };
    await runtime.startSession({ mode: "tui", sessionManager: staleManager, isIdle: () => true });
    await runtime.startSession({ mode: "tui", sessionManager: activeManager, isIdle: () => true });
    const state = internal(runtime);

    runtime.handleAgentStart({ sessionManager: staleManager, isIdle: () => true });
    await runtime.shutdownSession({ sessionManager: staleManager });
    expect(state.active).toBe(false);
    expect(state.rootSession).toBe(true);

    runtime.handleAgentStart({ sessionManager: activeManager, isIdle: () => true });
    expect(state.active).toBe(true);
  });
});

test("fork-style ID mutation accepts only the owning manager's shutdown", async () => {
  await withRuntime(async (runtime) => {
    let sessionId = "root";
    const manager = { getSessionId: () => sessionId };
    const context = { mode: "tui", sessionManager: manager, isIdle: () => true };
    await runtime.startSession(context);
    const state = internal(runtime);

    runtime.handleAgentStart(context);
    expect(state.active).toBe(true);

    // Normal lifecycle callbacks retain the original manager-and-ID fence.
    sessionId = "forked-session";
    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] }, context);
    runtime.handleAgentSettled(context);
    expect(state.terminal).toBe("success");
    expect(state.active).toBe(true);

    // Pi legitimately reuses this manager for /fork shutdown after the ID changes.
    await runtime.shutdownSession({ sessionManager: manager });
    expect(state.rootSession).toBe(false);
    expect(state.consumer).toBeNull();
  });
});

test("all stale Pi callbacks are fenced by their context", async () => {
  await withRuntime(async (runtime, bus) => {
    const prior = { mode: "tui", sessionManager: { getSessionId: () => "root" }, isIdle: () => true, getContextUsage: () => ({ percent: 99 }) };
    const current = { mode: "tui", sessionManager: { getSessionId: () => "next" }, isIdle: () => true, getContextUsage: () => ({ percent: 1 }) };
    const hook = async (name: string, event: unknown, context: unknown) => {
      const listener = bus.hooks.get(name)?.[0];
      if (!listener) throw new Error(`missing ${name} hook`);
      await listener(event, context);
    };
    bus.getAllTools = () => [{ name: "todo", sourceInfo: { path: "test", source: "test", scope: "test", origin: "test" } }];
    await runtime.startSession(current);
    await hook("agent_start", { type: "agent_start" }, current);
    const state = internal(runtime);
    expect(state.rootSession).toBe(true);
    expect(state.terminal).toBe("success");

    await hook("message_end", { type: "message_end", message: { role: "assistant", usage: { totalTokens: 99 } } }, prior);
    await hook("tool_result", { type: "tool_result", toolName: "todo", toolCallId: "stale", input: {}, content: [], isError: true, details: undefined }, prior);
    await hook("agent_end", { type: "agent_end", messages: [{ stopReason: "error" }] }, prior);
    await hook("session_shutdown", { type: "session_shutdown", reason: "new" }, prior);

    expect(state.rootSession).toBe(true);
    expect(state.terminal).toBe("success");
    expect(state.toolFailed).toBe(false);
    expect(state.usage.snapshot()).toEqual({ contextPercent: 1 });
    expect(state.lastTodoState).toBeNull();

    await hook("message_end", { type: "message_end", message: { role: "assistant", usage: { totalTokens: 7 } } }, current);
    await hook("tool_result", { type: "tool_result", toolName: "todo", toolCallId: "current", input: {}, content: [], isError: false, details: { action: "update", params: {}, tasks: [{ id: 1, status: "in_progress" }], nextId: 2 } }, current);
    expect(state.usage.snapshot()).toEqual({ tokens: 7, contextPercent: 1 });
    expect(state.lastTodoState).not.toBeNull();
  });
});

test("agent_end derives the terminal state and agent_settled settles it once", async () => {
  await withRuntime(async (runtime, bus, requests) => {
    const context = activeContext(runtime);
    const hook = async (name: string, event: unknown, callbackContext: unknown) => {
      const listener = bus.hooks.get(name)?.[0];
      if (!listener) throw new Error(`missing ${name} hook`);
      await listener(event, callbackContext);
    };
    await hook("agent_start", { type: "agent_start" }, context);
    const state = internal(runtime);
    const before = requests.length;

    await hook("agent_end", { type: "agent_end", messages: [{ stopReason: "error" }] }, context);
    expect(state.active).toBe(true);
    expect(state.terminal).toBe("error");
    await hook("agent_settled", { type: "agent_settled" }, context);
    await hook("agent_settled", { type: "agent_settled" }, context);

    expect(state.active).toBe(false);
    expect(state.lastPiState).toMatchObject({ state: "error", attention: { reason: "failure" } });
    expect(state.terminalRecords).toHaveLength(1);
    await pause();
    expect(agentRequests(requests.slice(before)).filter((request) => request.params.state === "blocked")).toHaveLength(1);
  });
});

test("consumer activation failure emits no socket output and releases local handles", async () => {
  const claimant = createPresenceConsumer({ id: "pi-herdr-presence" })!;
  expect(claimant.activate()).toBe(true);
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-consumer-failure-"));
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: join(directory, "socket"),
      HERDR_PANE_ID: "pane",
      PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir"),
    });
    const runtime = new PresenceRuntime(makeBus() as never, { ...resolvePresenceConfig(), soleReporter: true });
    const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
    await runtime.startSession(context);
    expect(internal(runtime).consumerActive).toBe(false);
    expect(internal(runtime).consumer).toBeNull();
    expect(internal(runtime).localPi).toBeNull();
  } finally {
    claimant.deactivate();
    restore(saved);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("session request precedes replayed retained output and retained attention stays quiet", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-replay-order-"));
  const socket = join(directory, "socket");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    expect(producer.activate()).toBe(true);
    expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } })).toBe(true);

    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await pause();

    expect(requests.slice(0, 5).map(request => request.method)).toEqual(["pane.report_metadata", "pane.report_metadata", "pane.report_agent_session", "pane.report_agent", "pane.report_metadata"]);
    expectExactMetadataClear(requests[0]?.params);
    expectExactLegacyMetadataClear(requests[1]?.params);
    expect(requests.map(request => request.method)).not.toContain("notification.show");
  } finally {
    producer.deactivate();
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a failed startup migration is isolated without retrying or suppressing the runtime projection", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-migration-failure-"));
  const socket = join(directory, "socket");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    return request.method === "pane.report_metadata" && "active" in (request.params.tokens as object)
      ? "invalid response"
      : JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true });
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await pause();

    const migrations = requests.filter((request) => request.method === "pane.report_metadata" && "active" in (request.params.tokens as object));
    expect(migrations).toHaveLength(1);
    expectExactLegacyMetadataClear(migrations[0]?.params);
    expect(requests.some((request) => request.method === "pane.report_agent")).toBe(true);
    expect(requests.some((request) => request.method === "pane.report_metadata" && "title" in request.params)).toBe(true);
    expect(requests.some((request) => request.method === "notification.show")).toBe(false);
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("gated startup retains post-activation live input, paired failure, terminal, and blocked notifications", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-edges-"));
  const socket = join(directory, "socket");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  let sessionSeen!: () => void;
  const seenSession = new Promise<void>((resolve) => { sessionSeen = resolve; });
  const server = await fakeSocket(socket, async (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    if (request.method === "pane.report_agent_session") {
      sessionSeen();
      await sessionGate;
    }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...{ ...resolvePresenceConfig(), soleReporter: true }, finalClearMs: 1_000 });
  const interaction = createPresenceProducer({ source: "interaction", emit: bus.events.emit })!;
  const subagent = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenSession;
    expect(interaction.activate()).toBe(true);
    expect(subagent.activate()).toBe(true);
    expect(interaction.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } })).toBe(true);
    expect(subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "error", attention: { reason: "failure", occurrence: "new" } })).toBe(true);
    expect(subagent.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" })).toBe(true);
    expect(subagent.publishState({ version: 2, generation: 1, sequence: 3, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
    expect(requests.map((request) => request.method)).toEqual(["pane.report_metadata", "pane.report_metadata", "pane.report_agent_session"]);

    releaseSession();
    await starting;
    await pause(100);

    const methods = requests.map((request) => request.method);
    const currentClearIndex = requests.findIndex((request) => request.method === "pane.report_metadata" && "clear_title" in request.params);
    const legacyClearIndex = requests.findIndex((request) => request.method === "pane.report_metadata" && "active" in (request.params.tokens as object));
    const sessionIndex = methods.indexOf("pane.report_agent_session");
    const agentIndex = methods.indexOf("pane.report_agent");
    const metadataIndex = requests.findIndex((request) => request.method === "pane.report_metadata" && "title" in request.params);
    expect(currentClearIndex).toBeGreaterThanOrEqual(0);
    expect(legacyClearIndex).toBeGreaterThan(currentClearIndex);
    expect(sessionIndex).toBeGreaterThan(legacyClearIndex);
    expect(agentIndex).toBeGreaterThan(sessionIndex);
    expect(metadataIndex).toBeGreaterThan(agentIndex);
    // Activation replay remains quiet, but these accepted events arrived after
    // activate() returned. The paired state failure is suppressed by its live
    // terminal, while input → terminal → blocked preserves arrival order.
    const notices = requests.filter((request) => request.method === "notification.show");
    expect(notices.map((request) => request.params)).toEqual([
      { title: "Pi needs your input", body: "Pi needs your input", sound: "request" },
      { title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" },
      { title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" },
    ]);
    const terminalTokens = requests
      .filter((request) => request.method === "pane.report_metadata")
      .map((request) => request.params.tokens as Record<string, string | null>)
      .find((tokens) => tokens.v2_terminals === "subagent:1:1:failed");
    expect(terminalTokens).toBeDefined();
    expect(terminalTokens?.v2_attention).toBe("input_required:new");
  } finally {
    interaction.deactivate();
    subagent.deactivate();
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle edges arriving after consumer activation but before session authority commit replay in order", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-mid-window-"));
  const socket = join(directory, "socket");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  let sessionSeen!: () => void;
  const seenSession = new Promise<void>((resolve) => { sessionSeen = resolve; });
  const server = await fakeSocket(socket, async (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    if (request.method === "pane.report_agent_session") { sessionSeen(); await sessionGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, finalClearMs: 1_000 });
  const context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "root" } };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession(context);
    await seenSession;
    // The consumer is already active here, but output/session authority is not.
    runtime.handleAgentStart(context);
    runtime.handleTurnStart(context);
    runtime.handleToolResult({ isError: true }, context);
    runtime.handleAgentEnd({ messages: [] }, context);
    runtime.handleAgentSettled(context);
    runtime.handleAgentStart(context);
    runtime.handleMessageEnd({ message: { role: "assistant", usage: { totalTokens: 7 } } }, context);
    runtime.handleToolResult({ isError: false }, context);
    runtime.handleAgentEnd({ messages: [] }, context);
    runtime.handleAgentSettled(context);
    expect(internal(runtime).pendingLifecycle?.edges).toHaveLength(10);
    expect(requests.map(request => request.method)).toEqual(["pane.report_metadata", "pane.report_metadata", "pane.report_agent_session"]);

    releaseSession();
    await starting;
    await pause();

    const state = internal(runtime);
    expect(state.terminalRecords).toMatchObject([{ outcome: "failed" }, { outcome: "completed" }]);
    expect(state.toolFailed).toBe(false);
    expect(state.usage.snapshot()).toMatchObject({ tokens: 7 });
    expect(requests.findIndex(request => request.method === "pane.report_agent_session")).toBeLessThan(requests.findIndex(request => request.method === "pane.report_agent"));
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("repeated detached session starts retain only the latest queued transition", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-coalesce-"));
  const socket = join(directory, "socket");
  const sessions: string[] = [];
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  let firstSeen!: () => void;
  const seenFirst = new Promise<void>((resolve) => { firstSeen = resolve; });
  const server = await fakeSocket(socket, async (line) => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    if (request.method === "pane.report_agent_session") {
      sessions.push(request.params.agent_session_id as string);
      if (sessions.length === 1) { firstSeen(); await sessionGate; }
    }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const runtime = new PresenceRuntime(makeBus() as never, { ...resolvePresenceConfig(), soleReporter: true });
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    const starts = [runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "first" } })];
    await seenFirst;
    let replacementContext: { mode: string; sessionManager: { getSessionId: () => string } } | undefined;
    for (let index = 0; index < 40; index += 1) {
      replacementContext = { mode: "tui", sessionManager: { getSessionId: () => `replacement-${index}` } };
      starts.push(runtime.startSession(replacementContext));
    }
    expect((runtime as unknown as { queuedStartup: unknown }).queuedStartup).not.toBeNull();
    releaseSession();
    await Promise.all(starts);
    expect(sessions).toEqual(["first", "replacement-39"]);
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("only the exact active ready receipt can activate local producer candidates", async () => {
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true });
  const consumer = createPresenceConsumer({ id: "pi-herdr-presence" })!;
  const state = internal(runtime);
  state.rootSession = true;
  state.ingressEpoch = 0;
  state.consumer = consumer;
  state.consumerReady = consumer.ready;
  state.consumerActive = true;

  state.handleConsumerReady({ ...consumer.ready });
  state.handleConsumerReady({ version: 2, sessionEpoch: consumer.ready.sessionEpoch, consumer: consumer.ready.consumer });
  expect(state.localPi).toBeNull();

  state.handleConsumerReady(consumer.ready);
  expect(state.localPi).not.toBeNull();
  (state.localPi as { deactivate?: () => void } | null)?.deactivate?.();
  (state.localTodo as { deactivate?: () => void } | null)?.deactivate?.();
  consumer.deactivate();
});

test("a local producer collision fails closed, then exact-ready takeover replays the retained local snapshot", async () => {
  const competing = createPresenceProducer({ source: "pi", emit: () => {} })!;
  expect(competing.activate()).toBe(true);
  try {
    await withRuntime(async (runtime, _bus, requests) => {
      const state = internal(runtime);
      expect(state.localPiActive).toBe(false);

      runtime.handleAgentStart(activeContext(runtime));
      expect(state.localPiActive).toBe(false);
      competing.deactivate();
      state.handleConsumerReady(state.consumerReady);
      await pause();

      expect(state.localPiActive).toBe(true);
      expect(agentRequests(requests).some((request) => request.params.state === "working")).toBe(true);
    });
  } finally {
    competing.deactivate();
  }
});

test("max ordinal rotation withdraws owned retained sources and accepts reset snapshots", async () => {
  await withRuntime(async (runtime, _bus, requests) => {
    const state = internal(runtime);
    expect(state.localPiActive).toBe(true);
    expect(state.localTodoActive).toBe(true);
    state.generation = MAX_INTEGER;
    state.sequence = MAX_INTEGER - 2;

    runtime.handleAgentStart(activeContext(runtime));
    await pause();

    expect(state.generation).toBe(0);
    expect(state.sequence).toBe(2);
    expect(state.localPiActive).toBe(true);
    expect(state.localTodoActive).toBe(true);
    expect(agentRequests(requests).at(-1)?.params).toMatchObject({ state: "working", agent_session_id: "root" });
  });
});

test("detached lifecycle overflow drops the complete uncoalesced sequence", async () => {
  const runtime = new PresenceRuntime(makeBus() as never, { ...{ ...resolvePresenceConfig(), soleReporter: true }, timeoutMs: 1 });
  const context = { mode: "tui", sessionManager: { getSessionId: () => "root" } };
  const starting = runtime.startSession(context);
  for (let index = 0; index <= 64; index += 1) runtime.handleAgentStart(context);
  expect(internal(runtime).pendingLifecycle).toMatchObject({ overflow: true, edges: [] });
  await starting;
  await runtime.shutdownSession((runtime as unknown as { context: object }).context);
});

test("stalled startup overflow fails closed while projecting final state and teardown fences producers", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-startup-overflow-"));
  const socket = join(directory, "socket");
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  let releaseReport!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  let reportSeen!: () => void;
  const seenReport = new Promise<void>(resolve => { reportSeen = resolve; });
  const server = await fakeSocket(socket, async line => {
    const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
    requests.push(request);
    if (request.method === "pane.report_agent") { reportSeen(); await reportGate; }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, notificationPolicy: "all", finalClearMs: 1_000 });
  const producer = createPresenceProducer({ source: "subagent", emit: bus.events.emit })!;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const starting = runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "root" } });
    await seenReport;
    expect(producer.activate()).toBe(true);
    for (let sequence = 1; sequence <= 65; sequence += 1) {
      expect(producer.publishState({ version: 2, generation: 1, sequence, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } })).toBe(true);
    }
    expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 66, source: "subagent", eventId: 1, outcome: "failed" })).toBe(true);
    releaseReport();
    await starting;
    await pause();

    expect(requests.filter(request => request.method === "notification.show")).toHaveLength(0);
    expect(agentRequests(requests).at(-1)?.params).toMatchObject({ state: "blocked" });
    const latest = requests.filter(request => request.method === "pane.report_metadata" && "title" in request.params).at(-1)?.params.tokens as Record<string, string | null>;
    expect(latest).toMatchObject({ v2_attention: "blocked:new", v2_terminals: "subagent:1:1:failed" });

    await runtime.shutdownSession(activeContext(runtime));
    const afterTeardown = requests.length;
    producer.publishState({ version: 2, generation: 1, sequence: 67, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } });
    await pause();
    expect(requests).toHaveLength(afterTeardown);
  } finally {
    releaseReport?.();
    producer.deactivate();
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("shutdown synchronously fences same-tick V2 ingress and notification output", async () => {
  await withRuntime(async (runtime, bus, requests) => {
    const producer = createPresenceProducer({ source: "interaction", emit: bus.events.emit })!;
    expect(producer.activate()).toBe(true);
    try {
      const before = requests.length;
      const stopping = runtime.shutdownSession(activeContext(runtime));
      runtime.handleAgentStart(activeContext(runtime));
      expect(producer.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } })).toBe(true);
      await pause();
      const after = requests.slice(before);
      expect(after.some(request => request.method === "notification.show")).toBe(false);
      expect(after.some(request => request.method === "pane.report_agent" && request.params.state === "blocked")).toBe(false);
      await stopping;
    } finally { producer.deactivate(); }
  });
});

test("shutdown requires a fenced context and cleans up through a fresh valid wrapper", async () => {
  const timeoutMs = 321;
  await withRuntime(async (runtime) => {
    const calls: number[] = [];
    internal(runtime).client = { async teardown(timeout) { calls.push(timeout); } };

    await runtime.shutdownSession({});
    expect(internal(runtime).rootSession).toBe(true);
    expect(calls).toEqual([]);

    const manager = internal(runtime).sessionManager;
    await runtime.shutdownSession({ sessionManager: manager ?? undefined });
    expect(calls).toEqual([timeoutMs]);
    expect(internal(runtime).rootSession).toBe(false);
    expect(internal(runtime).consumer).toBeNull();
  }, { ...resolvePresenceConfig(), soleReporter: true, timeoutMs });
});

test("V2 event names retain only the consumer-ready receipt channel", () => {
  expect(EVENT_NAMES.consumerReady).toBe("pi-presence:consumer-ready:v2");
  expect(EVENT_NAMES).toEqual({
    state: "pi-presence:state:v2",
    terminal: "pi-presence:terminal:v2",
    withdraw: "pi-presence:withdraw:v2",
    consumerReady: "pi-presence:consumer-ready:v2",
  });
});

test("detached lifecycle hooks retain immediate agent edges while startup socket work stalls", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-detached-hooks-"));
  const socket = join(directory, "socket");
  const server = await fakeSocket(socket, async () => await new Promise<string>(() => {}));
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const bus = makeBus();
  const runtime = new PresenceRuntime(bus as never, { ...{ ...resolvePresenceConfig(), soleReporter: true }, timeoutMs: 10, finalClearMs: 1_000 });
  const context = { mode: "tui", sessionManager: { getSessionId: () => "root" }, isIdle: () => true };
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir") });
    registerPresenceHooks(bus as never, runtime);
    const start = bus.hooks.get("session_start")?.[0];
    const agentStart = bus.hooks.get("agent_start")?.[0];
    const agentEnd = bus.hooks.get("agent_end")?.[0];
    const settled = bus.hooks.get("agent_settled")?.[0];
    const shutdown = bus.hooks.get("session_shutdown")?.[0];
    if (!start || !agentStart || !agentEnd || !settled || !shutdown) throw new Error("missing lifecycle hook");
    expect(start({ reason: "startup" }, context)).toBeUndefined();
    expect(agentStart({ type: "agent_start" }, context)).toBeUndefined();
    expect(bus.hooks.get("turn_start")?.[0]?.({ type: "turn_start" }, context)).toBeUndefined();
    expect(bus.hooks.get("tool_result")?.[0]?.({ type: "tool_result", isError: true }, context)).toBeUndefined();
    expect(agentEnd({ messages: [] }, context)).toBeUndefined();
    expect(settled({ type: "agent_settled" }, context)).toBeUndefined();
    expect(agentStart({ type: "agent_start" }, context)).toBeUndefined();
    expect(bus.hooks.get("message_end")?.[0]?.({ type: "message_end", message: { role: "assistant", usage: { totalTokens: 7 } } }, context)).toBeUndefined();
    await pause(160);
    // The bounded derived-edge queue retains start → turn → tool → end →
    // settled → start → message, rather than compressing it into booleans.
    expect(internal(runtime).active).toBe(true);
    expect(internal(runtime).lastPiState).toMatchObject({ state: "running" });
    expect(internal(runtime).terminalRecords).toHaveLength(1);
    expect(internal(runtime).terminalRecords[0]).toMatchObject({ outcome: "failed" });
    expect(internal(runtime).usage.snapshot()).toMatchObject({ tokens: 7 });
    expect(shutdown({ type: "session_shutdown" }, context)).toBeUndefined();
    // Shutdown invalidates ownership before its detached best-effort cleanup settles.
    agentStart({ type: "agent_start" }, context);
    expect(internal(runtime).active).toBe(true);
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
