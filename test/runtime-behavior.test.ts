import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { createPresenceProducer, EVENT_NAMES } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { deriveTerminalState, PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Listener = (payload: unknown) => void;
type Request = { method: string; params: Record<string, unknown> };
type Bus = {
  getAllTools(): unknown[];
  on(name: string, listener: (...args: unknown[]) => void): void;
  events: { on(name: string, listener: Listener): void; emit(name: string, payload: unknown): void };
};

const pause = (milliseconds = 100) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"] as const;

function bus(): Bus {
  const listeners = new Map<string, Listener[]>();
  return {
    getAllTools() { return []; },
    on() {},
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
  policy: "errors" | "background" | "all",
  run: (runtime: PresenceRuntime, events: Bus, requests: Request[]) => Promise<void>,
  finalClearMs = 0,
) {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-behavior-v2-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line) as Request & { id: string };
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const events = bus();
  const runtime = new PresenceRuntime(events as never, {
    ...{ ...resolvePresenceConfig(), soleReporter: true },
    notificationPolicy: policy,
    finalClearMs,
  });
  registerPresenceHooks(events as never, runtime);
  try {
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socket,
      HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace",
      PI_CODING_AGENT_DIR: join(directory, "missing-agent-dir"),
    });
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    await run(runtime, events, requests);
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

const notices = (requests: Request[]) => requests.filter((request) => request.method === "notification.show");
const metadata = (requests: Request[]) => requests.filter((request) => request.method === "pane.report_metadata").map((request) => request.params.tokens as Record<string, string | null>);
const reportMessages = (requests: Request[]) => requests.filter((request) => request.method === "pane.report_agent").map((request) => request.params.message);

test("handled nested failures do not fail a successful parent; unhandled parent failures still fail", async () => {
  await withRuntime("all", async (runtime, events, requests) => {
    events.getAllTools = () => [{ name: "todo", sourceInfo: { path: "/todo", source: "project", scope: "project", origin: "top" } }];
    const internal = runtime as unknown as { context: object; toolFailed: boolean; lastTodoState: unknown; terminalRecords: Array<{ outcome: string }> };
    const context = internal.context;
    const todo = { type: "tool_result", toolName: "todo", toolCallId: "parent/1", parentToolCallId: "parent", isError: false, details: { action: "list", params: {}, nextId: 3, tasks: [{ id: 1, status: "completed", subject: "PRIVATE_TASK" }, { id: 2, status: "pending" }] } };
    runtime.handleAgentStart(context);
    runtime.handleToolResult(todo, context);
    expect(internal.lastTodoState).toMatchObject({ progress: { completed: 1, total: 2 } });
    const progress = internal.lastTodoState;
    runtime.handleToolResult({ ...todo, toolCallId: "parent/2", isError: true }, context);
    runtime.handleToolResult({ ...todo, toolCallId: "parent/3/1", parentToolCallId: "parent/3", isError: true }, context);
    expect(internal.lastTodoState).toBe(progress);
    for (const parentToolCallId of [null, "", 1, {}]) {
      runtime.handleToolResult({ isError: true, parentToolCallId }, context);
      expect(internal.toolFailed).toBe(false);
    }
    let reads = 0;
    const accessor = { isError: true };
    Object.defineProperty(accessor, "parentToolCallId", { get() { reads += 1; return undefined; } });
    runtime.handleToolResult(accessor, context);
    expect(reads).toBe(0);
    expect(internal.toolFailed).toBe(false);
    expect(internal.terminalRecords).toHaveLength(0);
    runtime.handleToolResult({ toolName: "codemode", toolCallId: "parent", isError: false }, context);
    runtime.handleAgentEnd({ messages: [{ stopReason: "toolUse" }] }, context);
    runtime.handleAgentSettled(context);
    expect(internal.terminalRecords).toMatchObject([{ outcome: "completed" }]);
    await pause();
    expect(notices(requests).some(request => request.params.sound === "request")).toBe(false);
    expect(JSON.stringify(metadata(requests))).not.toContain("PRIVATE_TASK");

    runtime.handleAgentStart(context);
    runtime.handleToolResult({ ...todo, isError: true }, context);
    runtime.handleToolResult({ toolName: "codemode", toolCallId: "parent", parentToolCallId: undefined, isError: true }, context);
    expect(internal.toolFailed).toBe(true);
    runtime.handleAgentEnd({ messages: [{ stopReason: "toolUse" }] }, context);
    runtime.handleAgentSettled(context);
    expect(internal.terminalRecords).toMatchObject([{ outcome: "completed" }, { outcome: "failed" }]);
  }, 1_000);
});

test("retained V2 state is consumed once and consumer-ready does not recurse through the synchronous bus", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-retained-v2-"));
  const socket = join(directory, "socket");
  const requests: Request[] = [];
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line) as Request & { id: string };
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  const events = bus();
  const retained = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => events.events.emit(name, payload) })!;
  let runtime: PresenceRuntime | undefined;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "missing") });
    expect(retained.activate()).toBe(true);
    expect(retained.publishState({
      version: 2,
      generation: 1,
      sequence: 1,
      source: "subagent",
      state: "running",
      subagents: { running: 1, cancelling: 0, queued: 0, completed: 0, failed: 0, cancelled: 0, omitted: 0 },
    })).toBe(true);
    runtime = new PresenceRuntime(events as never, { ...{ ...resolvePresenceConfig(), soleReporter: true }, notificationPolicy: "all" });
    registerPresenceHooks(events as never, runtime);
    let readyEvents = 0;
    events.events.on(EVENT_NAMES.consumerReady, () => { readyEvents += 1; });

    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    await pause();

    expect(readyEvents).toBe(1);
    expect(reportMessages(requests)).toContain("Subagents are working");
    expect(notices(requests)).toHaveLength(0);
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
  } finally {
    if (runtime) await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    retained.deactivate();
    restore(saved);
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("subagent terminal success, failure, and cancellation project canonical typed records and dedupe replay", async () => {
  await withRuntime("all", async (runtime, events, requests) => {
    const producer = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => events.events.emit(name, payload) })!;
    expect(producer.activate()).toBe(true);
    try {
      expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "completed" })).toBe(true);
      await pause(300);
      expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 2, outcome: "failed" })).toBe(true);
      await pause(300);
      expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 3, source: "subagent", eventId: 3, outcome: "cancelled" })).toBe(true);
      await pause(300);
      expect(producer.publishTerminal({ version: 2, generation: 1, sequence: 4, source: "subagent", eventId: 3, outcome: "cancelled" })).toBe(false);
      await pause(100);

      expect((runtime as unknown as { consumerActive: boolean; terminalRecords: unknown[] }).consumerActive).toBe(true);
      expect((runtime as unknown as { terminalRecords: unknown[] }).terminalRecords).toHaveLength(3);
      expect(metadata(requests).some((tokens) => tokens.v2_terminals === "subagent:1:1:completed,subagent:1:2:failed,subagent:1:3:cancelled")).toBe(true);
      expect(metadata(requests).at(-1)?.summary).toBe("idle · terminal cancelled");
      // Cancellation stays display-only; completed and failed terminals retain their policy-gated alerts.
      expect(notices(requests)).toHaveLength(2);
      expect(JSON.stringify(requests)).not.toContain("private agent task");
    } finally {
      producer.deactivate();
    }
  }, 5_000);
});

test("an active parent preserves configured background terminal projection", async () => {
  await withRuntime("background", async (runtime, events, requests) => {
    const producer = createPresenceProducer({ source: "subagent", emit: (name: string, payload: unknown) => events.events.emit(name, payload) })!;
    expect(producer.activate()).toBe(true);
    try {
      (runtime as unknown as { active: boolean }).active = true;
      expect(producer.publishTerminal({ version: 2, generation: 2, sequence: 1, source: "subagent", eventId: 1, outcome: "completed" })).toBe(true);
      expect(producer.publishTerminal({ version: 2, generation: 2, sequence: 2, source: "subagent", eventId: 2, outcome: "failed" })).toBe(true);
      await pause(500);

      expect(metadata(requests).some((tokens) => tokens.v2_terminals === "subagent:2:1:completed,subagent:2:2:failed")).toBe(true);
      expect(metadata(requests).at(-1)?.summary).toBe("working · terminal failed");
      expect(notices(requests)).toHaveLength(2);
    } finally {
      producer.deactivate();
    }
  }, 5_000);
});

test("a consumed delivery receipt cannot be replayed into the runtime", async () => {
  const captured: Array<{ name: string; payload: unknown }> = [];
  await withRuntime("all", async (runtime, events, requests) => {
    events.events.on(EVENT_NAMES.state, (payload) => captured.push({ name: EVENT_NAMES.state, payload }));
    const producer = createPresenceProducer({ source: "interaction", emit: (name: string, payload: unknown) => events.events.emit(name, payload) })!;
    expect(producer.activate()).toBe(true);
    try {
      expect(producer.publishState({
        version: 2,
        generation: 1,
        sequence: 1,
        source: "interaction",
        state: "waiting",
        interaction: { kind: "ask_user", pending: 1 },
        attention: { reason: "input_required", occurrence: "new" },
      })).toBe(true);
      await pause(500);
      const reportsBeforeReplay = reportMessages(requests).length;
      expect(captured).toHaveLength(1);

      runtime.handlePresenceEvent(captured[0]!.name, captured[0]!.payload);
      await pause(500);

      expect(reportMessages(requests)).toHaveLength(reportsBeforeReplay);
      expect(metadata(requests).some((tokens) => tokens.v2_interaction === "ask_user:1" && tokens.v2_attention === "input_required:new")).toBe(true);
      expect(notices(requests)).toHaveLength(1);
    } finally {
      producer.deactivate();
    }
  });
});

test("deriveTerminalState preserves retry recovery, failures, cancellation, and fallback failure", () => {
  expect(deriveTerminalState({ messages: [{ stopReason: "error" }, { stopReason: "stop" }] }, true)).toBe("success");
  expect(deriveTerminalState({ messages: [{ stopReason: "error" }] })).toBe("error");
  expect(deriveTerminalState({ messages: [{ stopReason: "aborted" }] })).toBe("cancelled");
  expect(deriveTerminalState({}, true)).toBe("error");
  expect(deriveTerminalState({ messages: [{ stopReason: "toolUse" }] }, true)).toBe("error");
  expect(deriveTerminalState({ messages: [{ stopReason: "toolUse" }] }, false)).toBe("success");
  expect(deriveTerminalState({ messages: [{ stopReason: "error" }, { stopReason: "length" }] }, true)).toBe("success");
});
