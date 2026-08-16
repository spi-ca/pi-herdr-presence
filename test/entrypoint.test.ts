import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { basename, join } from "node:path";
import extension from "../index.js";
import { PI_PRESENCE_REMOVE_EVENT, PI_PRESENCE_UPDATE_EVENT, type PresenceUpdate } from "../src/events.js";
import { fakeSocket } from "./helpers/fake-socket.js";
import { presenceStatusKey } from "../src/presence.js";

test("entrypoint registers lifecycle and generic event observers without tools", () => {
  const previousEnabled = process.env.PI_CMUX_PRESENCE_ENABLED;
  process.env.PI_CMUX_PRESENCE_ENABLED = "true";
  try {
    const hooks: string[] = [];
    const events: string[] = [];
    extension({
      on(name: string) { hooks.push(name); },
      events: { on(name: string) { events.push(name); }, emit() {} },
    } as never);
    expect(events).toEqual(["pi-presence:update:v1", "pi-presence:remove:v1", "pi-presence:ready:v1"]);
    expect(hooks).toContain("session_start");
    expect(hooks).toContain("tool_result");
    expect(hooks).toContain("agent_settled");
    expect(hooks).toContain("session_shutdown");
  } finally {
    if (previousEnabled === undefined) delete process.env.PI_CMUX_PRESENCE_ENABLED;
    else process.env.PI_CMUX_PRESENCE_ENABLED = previousEnabled;
  }
});

test("entrypoint does not register observers when disabled", () => {
  const previousEnabled = process.env.PI_CMUX_PRESENCE_ENABLED;
  process.env.PI_CMUX_PRESENCE_ENABLED = "false";
  try {
    const hooks: string[] = [];
    const events: string[] = [];
    extension({
      on(name: string) { hooks.push(name); },
      events: { on(name: string) { events.push(name); }, emit() {} },
    } as never);
    expect(hooks).toEqual([]);
    expect(events).toEqual([]);
  } finally {
    if (previousEnabled === undefined) delete process.env.PI_CMUX_PRESENCE_ENABLED;
    else process.env.PI_CMUX_PRESENCE_ENABLED = previousEnabled;
  }
});

type Hook = (event: any, context?: any) => unknown;
type EventHandler = (payload: unknown) => unknown;

function fakePi() {
  const hooks = new Map<string, Hook[]>();
  const listeners = new Map<string, EventHandler[]>();
  const emitted: Array<{ name: string; payload: unknown }> = [];
  const tools: unknown[] = [];
  return {
    tools,
    api: {
      getAllTools() { return tools; },
      on(name: string, handler: Hook) {
        const handlers = hooks.get(name) ?? [];
        handlers.push(handler);
        hooks.set(name, handlers);
      },
      events: {
        on(name: string, handler: EventHandler) {
          const handlers = listeners.get(name) ?? [];
          handlers.push(handler);
          listeners.set(name, handlers);
        },
        emit(name: string, payload: unknown) {
          emitted.push({ name, payload });
          for (const handler of listeners.get(name) ?? []) void handler(payload);
        },
      },
    },
    emitted,
    emit(name: string, payload: unknown) {
      for (const handler of listeners.get(name) ?? []) void handler(payload);
    },
    async lifecycle(name: string, event: unknown = {}, context?: unknown) {
      for (const handler of hooks.get(name) ?? []) await handler(event, context);
    },
  };
}

test("uses agent_end settlement only when agent_settled registration throws", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension({
      ...pi.api,
      on(name: string, handler: Hook) {
        if (name === "agent_settled") throw new Error("unsupported lifecycle");
        pi.api.on(name, handler);
      },
    } as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "fallback-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] }, { isIdle: () => false });

    const localUpdates = pi.emitted
      .filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT)
      .map((event) => event.payload as PresenceUpdate)
      .filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "success", counts: { active: 0, completed: 1 } });
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("settled local success notifies exactly once only after an idle settlement", async () => {
  const fixture = await presenceFixture();
  try {
    process.env.PI_CMUX_PRESENCE_NOTIFY_POLICY = " settled ";
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "settled-local-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled", {}, { isIdle: () => false });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);

    await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi"') && line.includes('"body":"Response ready"')));
    await pi.lifecycle("agent_settled", {}, { isIdle: () => true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.lines.filter((line) => line.includes('"method":"notification.create_for_surface"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

const ENV_KEYS = [
  "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH", "PI_CODING_AGENT_DIR", "CMUX_PI_HOOKS_DISABLED", "HOME",
  "PI_CMUX_PRESENCE_ENABLED", "PI_CMUX_PRESENCE_TIMEOUT_MS", "PI_CMUX_PRESENCE_MAX_QUEUE",
  "PI_CMUX_PRESENCE_PROGRESS", "PI_CMUX_PRESENCE_NOTIFICATIONS", "PI_CMUX_PRESENCE_FLASH",
  "PI_CMUX_PRESENCE_NOTIFY_POLICY", "PI_CMUX_PRESENCE_FLASH_POLICY",
  "PI_CMUX_PROFILE", "PI_CMUX_NOTIFY_LEVEL", "PI_CMUX_SIDEBAR_FLASH", "PI_CMUX_SIDEBAR_SOURCE",
  "PI_CMUX_PRESENCE_LOG", "PI_CMUX_PRESENCE_SIDEBAR", "PI_CMUX_PRESENCE_NATIVE_LIFECYCLE",
  "PI_CMUX_PRESENCE_FEED", "PI_CMUX_PRESENCE_META_BLOCK", "PI_CMUX_PRESENCE_AUTO_TITLE",
  "PI_CMUX_PRESENCE_RESUME_FALLBACK", "PI_CMUX_PRESENCE_FINAL_CLEAR_MS", "PI_CMUX_PRESENCE_MAX_LABEL_CHARS",
];

function replaceEnv(values: Record<string, string>): () => void {
  const previous = new Map(ENV_KEYS.map((name) => [name, process.env[name]]));
  for (const name of ENV_KEYS) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 100): Promise<void> {
  for (let attempts = 0; attempts < timeoutMs; attempts += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for fake socket requests.");
}

async function presenceFixture(
  firstCapabilityGate?: () => Promise<void>,
  requestGate?: (line: string) => Promise<void>,
  advertisedMethods = ["notification.create_for_surface"],
) {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const surfaceId = "00000000-0000-4000-8000-000000000002";
  const lines: string[] = [];
  const requests: Array<{ line: string; at: number }> = [];
  const directory = await fs.mkdtemp(join(os.tmpdir(), "presence-lifecycle-"));
  const socketPath = join(directory, "cmux.sock");
  let capabilityRequests = 0;
  const server = await fakeSocket(socketPath, async (line) => {
    lines.push(line);
    requests.push({ line, at: performance.now() });
    await requestGate?.(line);
    if (line.startsWith("{")) {
      const request = JSON.parse(line) as { id: number; method: string };
      if (request.method === "system.capabilities") {
        capabilityRequests += 1;
        if (capabilityRequests === 1) await firstCapabilityGate?.();
      }
      const result = request.method === "system.capabilities"
        ? { protocol: "cmux-socket", version: 2, methods: advertisedMethods }
        : {};
      return JSON.stringify({ id: request.id, ok: true, result });
    }
    return "OK";
  });
  const restoreEnv = replaceEnv({
    CMUX_WORKSPACE_ID: workspaceId,
    CMUX_SURFACE_ID: surfaceId,
    CMUX_SOCKET_PATH: socketPath,
    PI_CMUX_PRESENCE_ENABLED: "true",
    PI_CMUX_PRESENCE_TIMEOUT_MS: "100",
    PI_CMUX_PRESENCE_MAX_QUEUE: "32",
    PI_CMUX_PRESENCE_PROGRESS: "true",
    PI_CMUX_PRESENCE_NOTIFICATIONS: "true",
    PI_CMUX_PRESENCE_FLASH: "true",
    PI_CMUX_PRESENCE_LOG: "false",
    PI_CMUX_PRESENCE_SIDEBAR: "true",
    PI_CMUX_PRESENCE_FINAL_CLEAR_MS: "60000",
  });
  return {
    workspaceId, surfaceId, lines, requests,
    cleanup: async () => { restoreEnv(); await server.close(); await fs.rm(directory, { recursive: true, force: true }); },
  };
}

test("lifecycle observes Pi and generic producers through only the targeted fake socket", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "lifecycle-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("tool_result", { isError: true });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled");

    const producer: PresenceUpdate = {
      version: 1,
      sessionId,
      generation: 9,
      sequence: 1,
      source: { id: "arbitrary-producer", label: "Any producer", kind: "custom" },
      state: "success",
      counts: { active: 0, completed: 1, failed: 0 },
      attention: "success",
    };
    pi.emit(PI_PRESENCE_UPDATE_EVENT, producer);
    await waitFor(() => fixture.lines.some((line) => line.includes("Pi · Needs attention")) && fixture.lines.some((line) => line.includes("Any producer: success · 1 done")));
    await pi.lifecycle("session_shutdown");

    const v1 = fixture.lines.filter((line) => !line.startsWith("{"));
    const v2 = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as { method: string; params: Record<string, unknown> });
    const localUpdates = pi.emitted
      .filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT)
      .map((event) => event.payload as PresenceUpdate)
      .filter((event) => event.source.id === "pi");
    const localKey = presenceStatusKey("pi", fixture.surfaceId);
    const producerKey = presenceStatusKey("arbitrary-producer", fixture.surfaceId);

    expect(localUpdates).toHaveLength(3);
    expect(localUpdates.every((event) => event.progress === undefined)).toBe(true);
    expect(v1.some((line) => line.startsWith("set_progress "))).toBe(false);
    expect(v1).toContain(`set_status ${localKey} "Pi · Needs attention" --icon=x --color=#dc2626 --priority=40 --tab=${fixture.workspaceId} --panel=00000000-0000-4000-8000-000000000002`);
    expect(v1).toContain(`set_status ${producerKey} "Any producer: success · 1 done" --icon=check --color=#16a34a --priority=20 --tab=${fixture.workspaceId} --panel=00000000-0000-4000-8000-000000000002`);
    expect(v1).toContain(`clear_status ${localKey} --tab=${fixture.workspaceId}`);
    expect(v1).toContain(`clear_status ${producerKey} --tab=${fixture.workspaceId}`);
    expect(v1.filter((line) => /^(set_status|clear_status) /.test(line)).every((line) => line.includes(`--tab=${fixture.workspaceId}`))).toBe(true);
    expect(v2).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "notification.create_for_surface",
        params: expect.objectContaining({ workspace_id: fixture.workspaceId, surface_id: "00000000-0000-4000-8000-000000000002", title: "Any producer" }),
      }),
    ]));
    expect(v2.some((request) => request.method === "surface.trigger_flash")).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("feed lifecycle sends only allowed privacy-minimal fields", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["feed.push"]);
  try {
    process.env.PI_CMUX_PRESENCE_FEED = "true";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "feed-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("before_agent_start");
    await pi.lifecycle("tool_execution_start", { toolCallId: "call-1", toolName: "todo" });
    await pi.lifecycle("tool_execution_end", { toolCallId: "call-1", toolName: "todo" });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.filter((line) => line.includes('"method":"feed.push"')).length === 5);

    const feedEvents = fixture.lines
      .filter((line) => line.startsWith("{"))
      .map((line) => JSON.parse(line) as { method: string; params: { event: Record<string, unknown> } })
      .filter((request) => request.method === "feed.push")
      .map((request) => request.params.event);
    expect(feedEvents.map((event) => event.hook_event_name)).toEqual([
      "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop",
    ]);
    for (const event of feedEvents) {
      expect(Object.keys(event).sort()).toEqual([
        "_source", "hook_event_name", "session_id", "surface_id", "tool_call_id", "tool_name", "workspace_id",
      ].filter((key) => key in event).sort());
      expect(event).toMatchObject({
        session_id: sessionId,
        _source: "pi",
        workspace_id: fixture.workspaceId,
        surface_id: fixture.surfaceId,
      });
    }
    expect(feedEvents[0]).toEqual({ session_id: sessionId, hook_event_name: "SessionStart", _source: "pi", workspace_id: fixture.workspaceId, surface_id: fixture.surfaceId });
    expect(feedEvents[2]).toMatchObject({ tool_call_id: "call-1", tool_name: "todo" });
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("matching ready replays retained local state with fresh sequence and no attention", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi(); extension(pi.api as never);
    const sessionId = "ready-session";
    pi.tools.push({ name: "todo", sourceInfo: { path: "/safe/todo.ts", source: "project", scope: "project", origin: "top-level" } });
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("tool_result", { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "completed" }] } });
    const before = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi").at(-1)!;
    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });
    const replay = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi").at(-1)!;
    const todoReplay = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi-todo").at(-1)!;
    expect(replay.sequence).toBeGreaterThan(before.sequence);
    expect(replay.attention).toBe("none");
    expect(todoReplay).toMatchObject({ state: "success", attention: "none", progress: { value: 1 } });
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("startup emits one frozen advertisement followed by one frozen replay request", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    const discovered: unknown[] = [];
    pi.api.events.on("pi-presence:ready:v1", (payload) => { discovered.push(payload); });
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "remove-ready-session" } });
    const ready = pi.emitted.filter((event) => event.name === "pi-presence:ready:v1").map((event) => event.payload);
    expect(ready).toHaveLength(2);
    const advertisement = ready[0] as { version: number; sessionId: string; consumer: { id: string; capabilities: string[] } };
    expect(Object.isFrozen(advertisement)).toBe(true);
    expect(Object.isFrozen(advertisement.consumer)).toBe(true);
    expect(Object.isFrozen(advertisement.consumer.capabilities)).toBe(true);
    expect(advertisement).toEqual({
      version: 1,
      sessionId: "remove-ready-session",
      consumer: { id: "pi-cmux-presence", capabilities: ["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"] },
    });
    expect(ready[1]).toEqual({ version: 1, sessionId: "remove-ready-session" });
    expect(Object.isFrozen(ready[1])).toBe(true);
    expect(discovered).toEqual(ready);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("consumer-first ready requests receive one advertisement and retain local replay", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "consumer-first-session";
    pi.tools.push({ name: "todo", sourceInfo: { path: "/safe/todo.ts", source: "project", scope: "project", origin: "top-level" } });
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("tool_result", { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "completed" }] } });
    const advertisements = () => pi.emitted.filter((event) => event.name === "pi-presence:ready:v1" && typeof event.payload === "object" && event.payload !== null && "consumer" in event.payload);
    const localUpdates = () => pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    const beforeAdvertisements = advertisements().length;
    const beforeLocalReplays = localUpdates().length;
    const beforeTodoReplays = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi-todo").length;
    const beforeReplay = localUpdates().at(-1)!;

    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });

    expect(advertisements()).toHaveLength(beforeAdvertisements + 1);
    expect(localUpdates()).toHaveLength(beforeLocalReplays + 1);
    expect(pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi-todo")).toHaveLength(beforeTodoReplays + 1);
    expect(advertisements().at(-1)?.payload).toEqual({
      version: 1,
      sessionId,
      consumer: {
        id: "pi-cmux-presence",
        capabilities: ["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"],
      },
    });
    const replay = localUpdates().at(-1)!;
    expect(replay.sequence).toBeGreaterThan(beforeReplay.sequence);
    expect(replay.attention).toBe("none");
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("two simulated producers observe only requests, not consumer advertisements", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    let producerRequests = 0;
    for (let index = 0; index < 2; index += 1) {
      pi.api.events.on("pi-presence:ready:v1", (payload) => {
        if (typeof payload === "object" && payload !== null && !("consumer" in payload)) producerRequests += 1;
      });
    }
    extension(pi.api as never);
    const sessionId = "two-producers-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    expect(producerRequests).toBe(2);
    const beforeAdvertisements = pi.emitted.filter((event) => event.name === "pi-presence:ready:v1" && typeof event.payload === "object" && event.payload !== null && "consumer" in event.payload).length;

    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });

    expect(producerRequests).toBe(4);
    expect(pi.emitted.filter((event) => event.name === "pi-presence:ready:v1" && typeof event.payload === "object" && event.payload !== null && "consumer" in event.payload)).toHaveLength(beforeAdvertisements + 1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("consumer ready advertisements do not loop and invalid requests are fenced", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "ready-fence-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const advertisements = () => pi.emitted.filter((event) => event.name === "pi-presence:ready:v1" && typeof event.payload === "object" && event.payload !== null && "consumer" in event.payload);
    const localUpdates = () => pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    const before = advertisements().length;
    const beforeUpdates = localUpdates().length;

    pi.emit("pi-presence:ready:v1", { version: 1, sessionId, consumer: { id: "other-consumer", capabilities: [] } });
    pi.emit("pi-presence:ready:v1", { version: 1, sessionId: "stale-session" });
    pi.emit("pi-presence:ready:v1", { version: 1, sessionId, consumer: null });
    pi.emit("pi-presence:ready:v1", { version: 2, sessionId });
    expect(advertisements()).toHaveLength(before);
    expect(localUpdates()).toHaveLength(beforeUpdates);

    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });
    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });
    expect(advertisements()).toHaveLength(before + 2);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("frozen ready output and nested requests cannot amplify one external request", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "ready-reentrancy-session";
    let mutate = false;
    pi.api.events.on("pi-presence:ready:v1", (payload) => {
      if (!mutate || typeof payload !== "object" || payload === null || !("consumer" in payload)) return;
      try {
        (payload as unknown as { sessionId: string }).sessionId = "mutated";
        ((payload as unknown as { consumer: { capabilities: string[] } }).consumer.capabilities).push("mutated");
      } catch {
        // Frozen outgoing payloads reject observer mutation.
      }
      pi.emit("pi-presence:ready:v1", { version: 1, sessionId });
    });
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const readyEvents = () => pi.emitted.filter((event) => event.name === "pi-presence:ready:v1");
    const localUpdates = () => pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    const beforeReady = readyEvents().length;
    const beforeUpdates = localUpdates().length;
    mutate = true;

    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });

    expect(readyEvents()).toHaveLength(beforeReady + 1);
    expect(localUpdates()).toHaveLength(beforeUpdates + 1);
    expect(readyEvents().at(-1)?.payload).toMatchObject({
      sessionId,
      consumer: { capabilities: ["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"] },
    });
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("ready advertisement emit failures do not interrupt retained replay", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "ready-emit-failure-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const localUpdates = () => pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    const before = localUpdates().at(-1)!;
    const originalEmit = pi.api.events.emit;
    pi.api.events.emit = (name: string, payload: unknown) => {
      if (name === "pi-presence:ready:v1") throw new Error("observer unavailable");
      originalEmit(name, payload);
    };

    expect(() => pi.emit("pi-presence:ready:v1", { version: 1, sessionId })).not.toThrow();
    const replay = localUpdates().at(-1)!;
    expect(replay.sequence).toBeGreaterThan(before.sequence);
    expect(replay.attention).toBe("none");
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("ready requests after shutdown produce no advertisement or local replay", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "ready-shutdown-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("session_shutdown");
    const beforeReady = pi.emitted.filter((event) => event.name === "pi-presence:ready:v1").length;
    const beforeUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).length;

    pi.emit("pi-presence:ready:v1", { version: 1, sessionId });

    expect(pi.emitted.filter((event) => event.name === "pi-presence:ready:v1")).toHaveLength(beforeReady);
    expect(pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT)).toHaveLength(beforeUpdates);
  } finally { await fixture.cleanup(); }
});

test("removal clears only retained external status, reselects progress, recomputes metadata, and stays silent", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash", "feed.push"]);
  try {
    process.env.PI_CMUX_PRESENCE_META_BLOCK = "true";
    process.env.PI_CMUX_PRESENCE_LOG = "true";
    process.env.PI_CMUX_PRESENCE_FEED = "true";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "remove-runtime-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (id: string, label: string, sequence: number, progress: number, attention: "none" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id, label, kind: "task" }, state: "running",
      counts: { active: 1, completed: 0, failed: attention === "error" ? 1 : 0 },
      progress: { value: progress, label }, attention,
    });
    update("remove-first", "First", 1, 0.25, "error");
    update("remove-second", "Second", 1, 0.75, "none");
    const firstKey = presenceStatusKey("remove-first", fixture.surfaceId);
    const secondKey = presenceStatusKey("remove-second", fixture.surfaceId);
    await waitFor(() => fixture.lines.some((line) => line.startsWith(`set_status ${firstKey} `))
      && fixture.lines.some((line) => line.startsWith(`set_status ${secondKey} `))
      && fixture.lines.some((line) => line.startsWith("set_progress ")));
    const beforeRemoval = {
      logs: fixture.lines.filter((line) => line.startsWith("log --level=")).length,
      notifications: fixture.lines.filter((line) => line.includes('"method":"notification.create_for_surface"')).length,
      flashes: fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length,
      feeds: fixture.lines.filter((line) => line.includes('"method":"feed.push"')).length,
      metadata: fixture.lines.filter((line) => line.startsWith("report_meta_block ")).length,
    };

    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId, generation: 1, sequence: 2, source: { id: "remove-first" } });
    await waitFor(() => fixture.lines.filter((line) => line.startsWith(`clear_status ${firstKey} `)).length === 1
      && fixture.lines.filter((line) => line.startsWith("set_progress ")).some((line) => line.includes('"Second"'))
      && fixture.lines.filter((line) => line.startsWith("report_meta_block ")).length > beforeRemoval.metadata);
    const firstRemovalMeta = fixture.lines.filter((line) => line.startsWith("report_meta_block ")).at(-1)!;
    expect(firstRemovalMeta.slice(firstRemovalMeta.indexOf(" -- ") + 4)).toBe("1\\n0\\n0\\n0\\n0\\n0\\n0\\n0.00\\n0");
    expect(fixture.lines.filter((line) => line.startsWith(`clear_status ${secondKey} `))).toHaveLength(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.lines.filter((line) => line.startsWith("log --level="))).toHaveLength(beforeRemoval.logs);
    expect(fixture.lines.filter((line) => line.includes('"method":"notification.create_for_surface"'))).toHaveLength(beforeRemoval.notifications);
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(beforeRemoval.flashes);
    expect(fixture.lines.filter((line) => line.includes('"method":"feed.push"'))).toHaveLength(beforeRemoval.feeds);

    const progressClearsBeforeSecond = fixture.lines.filter((line) => line.startsWith("clear_progress ")).length;
    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId, generation: 1, sequence: 2, source: { id: "remove-second" } });
    await waitFor(() => fixture.lines.filter((line) => line.startsWith(`clear_status ${secondKey} `)).length === 1
      && fixture.lines.filter((line) => line.startsWith("clear_progress ")).length > progressClearsBeforeSecond);
    const statusClearsAfterSecond = fixture.lines.filter((line) => line.startsWith(`clear_status ${secondKey} `)).length;
    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId, generation: 1, sequence: 3, source: { id: "remove-second" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.lines.filter((line) => line.startsWith(`clear_status ${secondKey} `))).toHaveLength(statusClearsAfterSecond);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("removal rejects stale sessions after reload and forged local ownership", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const source = { id: "reload-producer", label: "Reload producer", kind: "task" };
    const publish = (sessionId: string) => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 1, source,
      state: "running", counts: { active: 1, completed: 0, failed: 0 },
    });
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "remove-old-session" } });
    publish("remove-old-session");
    const producerKey = presenceStatusKey(source.id, fixture.surfaceId);
    await waitFor(() => fixture.lines.some((line) => line.startsWith(`set_status ${producerKey} `)));

    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "remove-current-session" } });
    publish("remove-current-session");
    await waitFor(() => fixture.lines.filter((line) => line.startsWith(`set_status ${producerKey} `)).length === 2);
    const before = fixture.lines.filter((line) => line.startsWith("clear_status ")).length;
    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId: "remove-old-session", generation: 1, sequence: 2, source: { id: source.id } });
    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId: "remove-current-session", generation: 99, sequence: 1, source: { id: "pi" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(fixture.lines.filter((line) => line.startsWith("clear_status "))).toHaveLength(before);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("pi-subagent removal invalidates a pending cumulative terminal", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "remove-subagent-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 1,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none",
    });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 2,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    });
    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId, generation: 1, sequence: 3, source: { id: "pi-subagent" } });
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(fixture.lines.some((line) => line.includes('"title":"Subagents completed"'))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("pi-subagent removal releases a suppressed parent fallback", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "remove-subagent-fallback-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, failed: number, attention: "none" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: failed ? "error" : "idle", counts: { active: 0, completed: 0, failed }, attention,
    });
    update(1, 0, "none");
    await pi.lifecycle("agent_start");
    update(2, 1, "error");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    pi.emit(PI_PRESENCE_REMOVE_EVENT, { version: 1, sessionId, generation: 1, sequence: 3, source: { id: "pi-subagent" } });
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi"'))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    expect(fixture.lines.some((line) => line.includes('"title":"Subagents need attention"'))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("pi-subagent terminals use a cumulative baseline, coalesce errors over successes, and flash errors only", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "subagent-policy-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, completed: number, failed: number, attention: "none" | "success" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 7, sequence,
      source: { id: "pi-subagent", label: "Leaky task label", kind: "agent-group" },
      state: failed ? "error" : completed ? "success" : "idle",
      counts: { active: 0, completed, failed }, attention,
    });
    update(1, 0, 0, "none"); // baseline
    update(2, 1, 0, "success");
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    update(3, 1, 1, "error");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Subagents need attention"') && line.includes("1 completed · 1 failed")));
    await new Promise<void>((resolve) => setTimeout(resolve, 800));

    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.params).toMatchObject({ title: "Subagents need attention", body: "1 completed · 1 failed" });
    expect(JSON.stringify(notifications)).not.toContain("Leaky task label");
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("session teardown fences pending pi-subagent success timers", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "subagent-teardown-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 1,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none",
    });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 2,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    });
    await pi.lifecycle("session_shutdown");
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    expect(fixture.lines.some((line) => line.includes('"title":"Subagents completed"'))).toBe(false);
  } finally { await fixture.cleanup(); }
});

test("pi-subagent success merges with parent settlement without delaying other producer routing", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "subagent-settlement-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 1,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none",
    });
    await pi.lifecycle("agent_start");
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 2,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi response ready"')), 700);
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.params).toMatchObject({
      title: "Pi response ready",
      body: "Subagents: 1 completed",
    });
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("an explicit agent_start inside the success grace joins the next parent settlement", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "subagent-grace-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 1, sequence: 1, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none" });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 1, sequence: 2, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "success", counts: { active: 0, completed: 2, failed: 0 }, attention: "success" });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi response ready"') && line.includes("Subagents: 2 completed")), 700);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("success coalescing keeps the first 450ms deadline during a sustained burst", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "subagent-success-deadline-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, completed: number) => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: completed ? "success" : "idle", counts: { active: 0, completed, failed: 0 },
      attention: completed ? "success" : "none",
    });
    update(1, 0);
    update(2, 1);
    // Subsequent terminals must aggregate without moving the first terminal's
    // 450ms deadline another 450ms into the future.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    update(3, 2);
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Subagents completed"') && line.includes("2 completed")), 400);
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.params).toMatchObject({ title: "Subagents completed", body: "2 completed" });
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("error coalescing keeps the first 100ms semantic deadline", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "subagent-error-deadline-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, failed: number) => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: failed ? "error" : "idle", counts: { active: 0, completed: 0, failed },
      attention: failed ? "error" : "none",
    });
    update(1, 0);
    update(2, 1);
    await new Promise<void>((resolve) => setTimeout(resolve, 70));
    update(3, 2);
    await waitFor(() => fixture.requests.some((request) => request.line.includes('"title":"Subagents need attention"')));
    const notification = fixture.requests.find((request) => request.line.includes('"title":"Subagents need attention"'))!;
    expect(notification.line).toContain("2 failed");
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("parent settlement waits for the first error window and aggregates a second failure once", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "parent-settlement-error-window-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, failed: number) => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: failed ? "error" : "idle", counts: { active: 0, completed: 0, failed },
      attention: failed ? "error" : "none",
    });
    update(1, 0);
    await pi.lifecycle("agent_start");
    update(2, 1);
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);

    update(3, 2);
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Subagents need attention"') && line.includes("2 failed"))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')), 250);
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.params).toMatchObject({ title: "Subagents need attention", body: "2 failed" });
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("generation replacement restores a parent error suppressed for a deferred child burst", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    process.env.CMUX_PI_HOOKS_DISABLED = "1";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "parent-error-generation-replacement-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (generation: number, sequence: number, failed: number, attention: "none" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation, sequence,
      source: { id: "pi-subagent", label: "Untrusted label", kind: "agent-group" },
      state: failed ? "error" : "idle", counts: { active: 0, completed: 0, failed }, attention,
    });
    update(1, 1, 0, "none");
    await pi.lifecycle("agent_start");
    update(1, 2, 1, "error");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    // This replaces the still-pending <=100ms child error burst before it can
    // dispatch, so the suppressed local parent terminal must be restored.
    update(2, 1, 0, "none");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi"'))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    await new Promise<void>((resolve) => setTimeout(resolve, 130));
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications.map((request) => request.params.title)).toEqual(["Pi"]);
    expect(JSON.stringify(notifications)).not.toContain("Untrusted label");
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    expect(fixture.lines.some((line) => line.includes('"title":"Subagents need attention"'))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("same-generation count reset restores a suppressed parent error once", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    process.env.CMUX_PI_HOOKS_DISABLED = "1";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "parent-error-count-reset-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, failed: number, attention: "none" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id: "pi-subagent", label: "Untrusted label", kind: "agent-group" },
      state: failed ? "error" : "idle", counts: { active: 0, completed: 0, failed }, attention,
    });
    update(1, 0, "none");
    await pi.lifecycle("agent_start");
    update(2, 1, "error");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    update(3, 0, "none");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi"'))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    await new Promise<void>((resolve) => setTimeout(resolve, 130));
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications.map((request) => request.params.title)).toEqual(["Pi"]);
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("parent settlement preserves the local error after pending child success", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "parent-error-after-success-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 1, sequence: 1, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none" });
    await pi.lifecycle("agent_start");
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 1, sequence: 2, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success" });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi"'))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications.map((request) => request.params.title)).toEqual(["Pi"]);
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("parent settlement emits an aggregate child error once", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "parent-error-after-child-error-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 1, sequence: 1, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none" });
    await pi.lifecycle("agent_start");
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 1, sequence: 2, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error" });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Subagents need attention"'))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line))
      .filter((request) => request.method === "notification.create_for_surface");
    expect(notifications.map((request) => request.params.title)).toEqual(["Subagents need attention"]);
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("official hook consumes successful child bursts before unrelated terminals", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  const agentDir = await fs.mkdtemp(join(os.tmpdir(), "presence-official-burst-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await fs.mkdir(join(agentDir, "extensions"));
    await fs.writeFile(join(agentDir, "extensions", "cmux-session.ts"), "cmux-pi-session-extension-marker v2");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CMUX_PRESENCE_LOG = "true";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "official-burst-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (sequence: number, completed: number, failed: number, attention: "none" | "success" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence,
      source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
      state: failed ? "error" : completed ? "success" : "idle",
      counts: { active: 0, completed, failed }, attention,
    });
    update(1, 0, 0, "none");
    update(2, 1, 0, "success");
    update(3, 2, 0, "success");
    // Starting a parent inside the grace must not strand an official-hook
    // success if that parent has not yet settled.
    await pi.lifecycle("agent_start");
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    await waitFor(() => fixture.lines.filter((line) => line.includes("log --level=success") && line.includes("2 completed")).length === 1);
    expect(fixture.lines.filter((line) => line.includes("log --level=success"))).toHaveLength(1);
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);

    update(4, 2, 1, "error");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Subagents need attention"') && line.includes("1 failed")));
    const errors = fixture.lines.filter((line) => line.includes('"title":"Subagents need attention"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("2 completed");
    await pi.lifecycle("session_shutdown");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(agentDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("default background policy leaves local success silent but alerts local errors", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    process.env.CMUX_PI_HOOKS_DISABLED = "true";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "local-terminal-policy-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);

    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes('"title":"Pi"'))
      && fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    expect(fixture.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("reviewed child profile preserves observer output while suppressing native attention under the official hook", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  const agentDir = await fs.mkdtemp(join(os.tmpdir(), "presence-child-profile-official-"));
  try {
    await fs.mkdir(join(agentDir, "extensions"));
    await fs.writeFile(join(agentDir, "extensions", "cmux-session.ts"), "cmux-pi-session-extension-marker v2");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_CMUX_PROFILE = "subagent-child-v1";
    process.env.PI_CMUX_NOTIFY_LEVEL = "disabled";
    process.env.PI_CMUX_SIDEBAR_FLASH = "disabled";
    process.env.PI_CMUX_SIDEBAR_SOURCE = "pi-subagent-child";
    process.env.PI_CMUX_PRESENCE_NOTIFY_POLICY = "all";
    process.env.PI_CMUX_PRESENCE_FLASH_POLICY = "attention";
    process.env.PI_CMUX_PRESENCE_LOG = "true";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "child-profile-official-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 1, sequence: 1,
      source: { id: "unrelated-producer", label: "Observer", kind: "task" },
      state: "running", counts: { active: 1, completed: 0, failed: 0 },
      progress: { value: 0.5, label: "Observer progress" }, attention: "error",
    });
    await waitFor(() => fixture.lines.some((line) => line.includes("Observer: running"))
      && fixture.lines.some((line) => line.startsWith("set_progress "))
      && fixture.lines.some((line) => line.startsWith("log --level=error")));
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);
    expect(fixture.lines.some((line) => line.startsWith("set_agent_pid "))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("reviewed child suppression also applies to deferred parent-error fallback", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    process.env.CMUX_PI_HOOKS_DISABLED = "1";
    process.env.PI_CMUX_PROFILE = "subagent-child-v1";
    process.env.PI_CMUX_NOTIFY_LEVEL = "disabled";
    process.env.PI_CMUX_SIDEBAR_FLASH = "disabled";
    process.env.PI_CMUX_PRESENCE_NOTIFY_POLICY = "all";
    process.env.PI_CMUX_PRESENCE_FLASH_POLICY = "attention";
    process.env.PI_CMUX_PRESENCE_LOG = "true";
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "child-profile-fallback-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    const update = (generation: number, sequence: number, failed: number, attention: "none" | "error") => pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation, sequence,
      source: { id: "pi-subagent", label: "Untrusted", kind: "agent-group" },
      state: failed ? "error" : "idle", counts: { active: 0, completed: 0, failed }, attention,
    });
    update(1, 1, 0, "none");
    await pi.lifecycle("agent_start");
    update(1, 2, 1, "error");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "error" }] });
    await pi.lifecycle("agent_settled");
    update(2, 1, 0, "none");
    await waitFor(() => fixture.lines.some((line) => line.startsWith("log --level=error") && line.includes("Needs attention")));
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("cancelled local runs publish no attention even under permissive policies", async () => {
  const fixture = await presenceFixture(undefined, undefined, ["notification.create_for_surface", "surface.trigger_flash"]);
  try {
    process.env.CMUX_PI_HOOKS_DISABLED = "1";
    process.env.PI_CMUX_PRESENCE_NOTIFY_POLICY = "all";
    process.env.PI_CMUX_PRESENCE_FLASH_POLICY = "attention";
    process.env.PI_CMUX_PRESENCE_LOG = "true";
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "cancelled-no-attention-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "aborted" }] });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes("Pi · Cancelled")));
    expect(fixture.lines.some((line) => line.startsWith("log --level="))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"notification.create_for_surface"'))).toBe(false);
    expect(fixture.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("official hook suppresses only local completion attention", async () => {
  const fixture = await presenceFixture();
  const agentDir = await fs.mkdtemp(join(os.tmpdir(), "presence-official-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  try {
    await fs.mkdir(join(agentDir, "extensions"));
    await fs.writeFile(join(agentDir, "extensions", "cmux-session.ts"), "cmux-pi-session-extension-marker v2");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const pi = fakePi(); extension(pi.api as never);
    const sessionId = "official-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start"); await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] }); await pi.lifecycle("agent_settled");
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 3, sequence: 1, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "idle", counts: { active: 0, completed: 0, failed: 0 }, attention: "none" });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 3, sequence: 2, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success" });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 3, sequence: 3, source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" }, state: "error", counts: { active: 0, completed: 1, failed: 1 }, attention: "error" });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, { version: 1, sessionId, generation: 2, sequence: 1, source: { id: "external", label: "External", kind: "task" }, state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success" });
    await waitFor(() => fixture.lines.some((line) => line.includes("External: success")) && fixture.lines.some((line) => line.includes('"title":"External"')) && fixture.lines.some((line) => line.includes('"title":"Subagents need attention"') && line.includes("1 completed · 1 failed")));
    const notifications = fixture.lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line)).filter((request) => request.method === "notification.create_for_surface");
    expect(notifications.some((request) => request.params.title === "Pi")).toBe(false);
    expect(notifications.some((request) => request.params.title === "External")).toBe(true);
    expect(notifications.filter((request) => request.params.title === "Subagents need attention")).toHaveLength(1);
    expect(notifications.some((request) => request.params.title === "Subagents completed")).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await fs.rm(agentDir, { recursive: true, force: true }); await fixture.cleanup(); }
});

test("metadata block is raw numeric aggregate data without task or source text", async () => {
  const fixture = await presenceFixture();
  try {
    process.env.PI_CMUX_PRESENCE_META_BLOCK = "true";
    const pi = fakePi(); extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "metadata-session" } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("report_meta_block ")));
    const line = fixture.lines.find((candidate) => candidate.startsWith("report_meta_block "))!;
    const body = line.slice(line.indexOf(" -- ") + 4);
    expect(body).toMatch(/^\d+(?:\\n\d+){6}\\n\d+\.\d{2}\\n\d+$/);
    expect(body).not.toContain('"');
    await pi.lifecycle("session_shutdown");
  } finally { await fixture.cleanup(); }
});

test("preserves aggregate usage across agent continuations and ignores forged local source events", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "aggregate-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("message_end", { message: { role: "assistant", usage: { totalTokens: 10, cost: 0.01 } } });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("tool_result", { isError: true });
    await pi.lifecycle("message_end", { message: { role: "assistant", usage: { totalTokens: 20, cost: 0.02 } } });
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1, sessionId, generation: 99, sequence: 1,
      source: { id: "pi", label: "Forged", kind: "untrusted" }, state: "success",
      counts: { active: 0, completed: 999, failed: 0 },
    });
    await pi.lifecycle("agent_settled");
    await waitFor(() => fixture.lines.some((line) => line.includes("Pi · Needs attention")));
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "error", counts: { active: 0, completed: 0, failed: 1 }, usage: { tokens: 30, cost: 0.03 } });
    expect(fixture.lines.some((line) => line.includes("Forged"))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("settled does not finalize a run started by an earlier settled handler", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    let restarted = false;
    pi.api.on("agent_settled", async () => {
      if (restarted) return;
      restarted = true;
      await pi.lifecycle("agent_start");
    });
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "reentrant-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "stop" }] });
    await pi.lifecycle("agent_settled", {}, { isIdle: () => false });
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "running", counts: { active: 1, completed: 0, failed: 0 } });
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("cancelled runs do not increment completed or failed counts", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "cancel-session" } });
    await pi.lifecycle("agent_start");
    await pi.lifecycle("agent_end", { messages: [{ stopReason: "aborted" }] });
    await pi.lifecycle("agent_settled");
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates.at(-1)).toMatchObject({ state: "cancelled", counts: { active: 0, completed: 0, failed: 0 } });
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("progress-disabled sessions never mutate workspace progress during startup or shutdown", async () => {
  const fixture = await presenceFixture();
  try {
    process.env.PI_CMUX_PRESENCE_PROGRESS = "false";
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "no-progress-session" } });
    await pi.lifecycle("session_shutdown");

    expect(fixture.lines.some((line) => /^(set_progress|clear_progress)\b/.test(line))).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("CMUX_PI_HOOKS_DISABLED bypasses an otherwise detected official hook", async () => {
  const fixture = await presenceFixture();
  const agentDir = await fs.mkdtemp(join(os.tmpdir(), "presence-disabled-hook-"));
  try {
    await fs.mkdir(join(agentDir, "extensions"));
    await fs.writeFile(join(agentDir, "extensions", "cmux-session.ts"), "cmux-pi-session-extension-marker v2");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.CMUX_PI_HOOKS_DISABLED = "1";
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "disabled-hook-session" } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_agent_pid ")));
    await pi.lifecycle("session_shutdown");
  } finally {
    await fs.rm(agentDir, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("tilde agent directories preserve official hook precedence with a temporary HOME", async () => {
  const fixture = await presenceFixture();
  const home = await fs.mkdtemp(join(os.tmpdir(), "presence-home-"));
  const agentDir = join(home, ".presence-official-");
  try {
    await fs.mkdir(join(agentDir, "extensions"), { recursive: true });
    await fs.writeFile(
      join(agentDir, "extensions", "cmux-session.ts"),
      "cmux-pi-session-extension-marker v2",
    );
    process.env.HOME = home;
    process.env.PI_CODING_AGENT_DIR = `~/${basename(agentDir)}`;

    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "tilde-session" } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    await pi.lifecycle("session_shutdown");

    expect(fixture.lines.some((line) => line.startsWith("set_agent_pid "))).toBe(false);
    expect(fixture.lines.some((line) => line.startsWith("set_agent_lifecycle "))).toBe(false);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("invalid session IDs fail closed without rejecting lifecycle hooks and later recover", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const invalidIds: unknown[] = ["", "x".repeat(97), "bad\u202e", "😀".repeat(97), undefined];

    for (const invalidId of invalidIds) {
      await expect(pi.lifecycle("session_start", {}, {
        sessionManager: { getSessionId: () => invalidId },
      })).resolves.toBeUndefined();
      await pi.lifecycle("agent_start");
      await pi.lifecycle("session_shutdown");
    }
    await expect(pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => { throw new Error("unavailable"); } },
    })).resolves.toBeUndefined();

    expect(fixture.lines).toEqual([]);
    expect(pi.emitted.some((event) => event.name === PI_PRESENCE_UPDATE_EVENT)).toBe(false);
    expect(pi.emitted.some((event) => event.name === "pi-presence:ready:v1")).toBe(false);

    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "recovered-session" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    const recovered = pi.emitted
      .filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT)
      .map((event) => event.payload as PresenceUpdate);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.sessionId).toBe("recovered-session");
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("an invalid replacement session clears the previous session outputs", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "valid-before-invalid" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    const oldKey = presenceStatusKey("pi", fixture.surfaceId);

    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "x".repeat(97) },
    });

    expect(fixture.lines).toContain(`clear_status ${oldKey} --tab=${fixture.workspaceId}`);
    expect(fixture.lines.filter((line) => line.startsWith("set_status "))).toHaveLength(1);
  } finally {
    await fixture.cleanup();
  }
});

test("detached cleanup sends every retained status clear beyond one close timeout", async () => {
  const responseDelayMs = 6;
  const fixture = await presenceFixture(undefined, async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, responseDelayMs));
  });
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "cleanup-tail-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));

    for (let index = 0; index < 40; index += 1) {
      pi.emit(PI_PRESENCE_UPDATE_EVENT, {
        version: 1,
        sessionId,
        generation: 1,
        sequence: index + 1,
        source: { id: `retained-${index}`, label: `Retained ${index}`, kind: "task" },
        state: "running",
        counts: { active: 1, completed: 0, failed: 0 },
      });
    }

    await pi.lifecycle("session_shutdown");

    const clears = fixture.requests.filter((request) => request.line.startsWith("clear_status "));
    expect(clears).toHaveLength(40);
    for (let index = 0; index < 40; index += 1) {
      const key = presenceStatusKey(`retained-${index}`, fixture.surfaceId);
      expect(clears.some((request) => request.line.startsWith(`clear_status ${key} `))).toBe(true);
    }
    expect(clears.at(-1)!.at - clears[0]!.at).toBeGreaterThan(100);
  } finally {
    await fixture.cleanup();
  }
});

test("silent cmux teardown is bounded by the aggregate cleanup deadline", async () => {
  let silenceClears = false;
  const fixture = await presenceFixture(undefined, async (line) => {
    if (silenceClears && line.startsWith("clear_status ")) {
      await new Promise<void>(() => {});
    }
  });
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const sessionId = "silent-cleanup-session";
    await pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => sessionId } });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));

    for (let index = 0; index < 64; index += 1) {
      pi.emit(PI_PRESENCE_UPDATE_EVENT, {
        version: 1,
        sessionId,
        generation: 1,
        sequence: index + 1,
        source: { id: `silent-${index}`, label: `Silent ${index}`, kind: "task" },
        state: "running",
        counts: { active: 1, completed: 0, failed: 0 },
      });
    }

    silenceClears = true;
    const started = performance.now();
    await pi.lifecycle("session_shutdown");
    expect(performance.now() - started).toBeLessThan(1_100);
    expect(fixture.requests.filter((request) => request.line.startsWith("clear_status ")).length).toBeLessThan(9);
  } finally {
    await fixture.cleanup();
  }
});

test("shutdown teardown finishes before a concurrently started session publishes", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "old-before-shutdown" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_status ")));
    const oldKey = presenceStatusKey("pi", fixture.surfaceId);

    const shutdown = pi.lifecycle("session_shutdown");
    const restart = pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "new-after-shutdown" },
    });
    await Promise.all([shutdown, restart]);
    await waitFor(() => fixture.lines.filter((line) => line.startsWith("set_status ")).length === 2);

    const clearIndex = fixture.lines.indexOf(`clear_status ${oldKey} --tab=${fixture.workspaceId}`);
    const statusIndices = fixture.lines
      .map((line, index) => line.startsWith("set_status ") ? index : -1)
      .filter((index) => index >= 0);
    const newStatusIndex = statusIndices.at(-1) ?? -1;
    expect(clearIndex).toBeGreaterThan(-1);
    expect(newStatusIndex).toBeGreaterThan(clearIndex);
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});

test("a session change during owned-progress setup does not retain the stale client", async () => {
  let releaseProgress!: () => void;
  const progressGate = new Promise<void>((resolve) => { releaseProgress = resolve; });
  let blockFirstProgressClear = true;
  const fixture = await presenceFixture(undefined, async (line) => {
    if (blockFirstProgressClear && line.startsWith("clear_progress ")) {
      blockFirstProgressClear = false;
      await progressGate;
    }
  });
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const first = pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "owned-progress-old" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("clear_progress ")));

    const second = pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "owned-progress-current" },
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      second.then(() => true),
      new Promise<boolean>((resolve) => { deadline = setTimeout(() => resolve(false), 100); }),
    ]);
    if (deadline) clearTimeout(deadline);
    expect(completed).toBe(true);
    expect(pi.emitted.some((event) => (event.payload as PresenceUpdate).sessionId === "owned-progress-current")).toBe(true);

    releaseProgress();
    await first;
    await pi.lifecycle("session_shutdown");
  } finally {
    releaseProgress();
    await fixture.cleanup();
  }
});

test("a delayed stale capability probe cannot clear newer session progress", async () => {
  let releaseCapability!: () => void;
  const capabilityGate = new Promise<void>((resolve) => { releaseCapability = resolve; });
  const fixture = await presenceFixture(() => capabilityGate);
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const first = pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "delayed-old-session" },
    });
    await waitFor(() => fixture.lines.some((line) => line.includes('"method":"system.capabilities"')));

    await pi.lifecycle("session_start", {}, {
      sessionManager: { getSessionId: () => "current-session" },
    });
    pi.emit(PI_PRESENCE_UPDATE_EVENT, {
      version: 1,
      sessionId: "current-session",
      generation: 1,
      sequence: 1,
      source: { id: "progress-owner", label: "Progress owner", kind: "task" },
      state: "running",
      counts: { active: 1, completed: 0, failed: 0 },
      progress: { value: 0.5, label: "Current progress" },
    });
    await waitFor(() => fixture.lines.some((line) => line.startsWith("set_progress ")));
    const progressIndex = fixture.lines.findIndex((line) => line.startsWith("set_progress "));

    releaseCapability();
    await first;
    expect(fixture.lines.slice(progressIndex + 1).some((line) => line.startsWith("clear_progress"))).toBe(false);
    await pi.lifecycle("session_shutdown");
  } finally {
    releaseCapability();
    await fixture.cleanup();
  }
});

test("a stale session start cannot publish or install after a newer start", async () => {
  const fixture = await presenceFixture();
  try {
    const pi = fakePi();
    extension(pi.api as never);
    const first = pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "old-session" } });
    const second = pi.lifecycle("session_start", {}, { sessionManager: { getSessionId: () => "new-session" } });
    await Promise.all([first, second]);
    const localUpdates = pi.emitted.filter((event) => event.name === PI_PRESENCE_UPDATE_EVENT).map((event) => event.payload as PresenceUpdate).filter((event) => event.source.id === "pi");
    expect(localUpdates).toHaveLength(1);
    expect(localUpdates[0]?.sessionId).toBe("new-session");
    await pi.lifecycle("session_shutdown");
  } finally {
    await fixture.cleanup();
  }
});
