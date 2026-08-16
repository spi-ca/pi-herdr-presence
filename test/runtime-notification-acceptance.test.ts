import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { resolvePresenceConfig } from "../src/config.js";
import type { PresenceUpdate } from "../src/events.js";
import { presenceStatusKey } from "../src/presence.js";
import { PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const ENV_KEYS = [
  "CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_SOCKET_PATH", "CMUX_PI_HOOKS_DISABLED",
  "PI_CMUX_PRESENCE_ENABLED", "PI_CMUX_PRESENCE_TIMEOUT_MS", "PI_CMUX_PRESENCE_MAX_QUEUE",
  "PI_CMUX_PRESENCE_NOTIFICATIONS", "PI_CMUX_PRESENCE_FLASH", "PI_CMUX_PRESENCE_NOTIFY_POLICY",
  "PI_CMUX_PRESENCE_FLASH_POLICY", "PI_CMUX_PRESENCE_FINAL_CLEAR_MS", "PI_CMUX_PRESENCE_LOG",
  "PI_CMUX_PROFILE", "PI_CMUX_NOTIFY_LEVEL", "PI_CMUX_SIDEBAR_FLASH", "PI_CMUX_SIDEBAR_SOURCE",
] as const;

function replaceEnv(values: Record<string, string | undefined>): () => void {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key];
    else process.env[key] = values[key];
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 150): Promise<void> {
  for (let attempt = 0; attempt < timeoutMs; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for fake socket requests.");
}

async function fixture(methods = ["notification.create_for_surface", "surface.trigger_flash"]) {
  const workspaceId = "00000000-0000-4000-8000-000000000011";
  const surfaceId = "00000000-0000-4000-8000-000000000012";
  const directory = await fs.mkdtemp(join(os.tmpdir(), "presence-notification-"));
  const socketPath = join(directory, "cmux.sock");
  const lines: string[] = [];
  const server = await fakeSocket(socketPath, (line) => {
    lines.push(line);
    if (!line.startsWith("{")) return "OK";
    const request = JSON.parse(line) as { id: number; method: string };
    return JSON.stringify({
      id: request.id,
      ok: request.method !== "notification.create_for_surface" || !line.includes("RPC_FAIL") ? true : false,
      ...(request.method === "system.capabilities"
        ? { result: { protocol: "cmux-socket", version: 2, methods } }
        : request.method === "notification.create_for_surface" && line.includes("RPC_FAIL")
          ? { error: { code: "denied", message: "RPC_FAIL" } }
          : { result: {} }),
    });
  });
  const restore = replaceEnv({
    CMUX_WORKSPACE_ID: workspaceId,
    CMUX_SURFACE_ID: surfaceId,
    CMUX_SOCKET_PATH: socketPath,
    CMUX_PI_HOOKS_DISABLED: "1",
    PI_CMUX_PRESENCE_ENABLED: "true",
    PI_CMUX_PRESENCE_TIMEOUT_MS: "100",
    PI_CMUX_PRESENCE_MAX_QUEUE: "32",
    PI_CMUX_PRESENCE_NOTIFICATIONS: "true",
    PI_CMUX_PRESENCE_FLASH: "true",
    PI_CMUX_PRESENCE_NOTIFY_POLICY: "all",
    PI_CMUX_PRESENCE_FLASH_POLICY: "attention",
    PI_CMUX_PRESENCE_FINAL_CLEAR_MS: "60000",
    PI_CMUX_PRESENCE_LOG: "false",
    PI_CMUX_PROFILE: undefined,
    PI_CMUX_NOTIFY_LEVEL: undefined,
    PI_CMUX_SIDEBAR_FLASH: undefined,
    PI_CMUX_SIDEBAR_SOURCE: undefined,
  });
  return {
    lines,
    workspaceId,
    surfaceId,
    cleanup: async () => {
      restore();
      await server.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

type Hook = (event: unknown, context?: unknown) => unknown;
type EventHandler = (payload: unknown) => unknown;

function fakePi() {
  const listeners = new Map<string, EventHandler[]>();
  return {
    api: {
      getAllTools: () => [],
      on: (_name: string, _handler: Hook) => {},
      events: {
        on(name: string, handler: EventHandler) {
          listeners.set(name, [...(listeners.get(name) ?? []), handler]);
        },
        emit(name: string, payload: unknown) {
          for (const handler of listeners.get(name) ?? []) void handler(payload);
        },
      },
    },
    emit(name: string, payload: unknown) {
      for (const handler of listeners.get(name) ?? []) void handler(payload);
    },
  };
}

function producerUpdate(sessionId: string, sequence: number, overrides: Partial<PresenceUpdate> = {}): PresenceUpdate {
  return {
    version: 1,
    sessionId,
    generation: 4,
    sequence,
    source: { id: "pi-subagent", label: "Subagents", kind: "agent-group" },
    state: "idle",
    counts: { active: 0, completed: 0, failed: 0 },
    attention: "none",
    ...overrides,
  };
}

function notifications(lines: string[]) {
  return lines.filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as {
    method: string;
    params: { title?: string; body?: string };
  }).filter((request) => request.method === "notification.create_for_surface");
}

class ManualRuntimeClock {
  nowMs = 0;
  readonly timers: Array<{ due: number; callback: () => void; cleared: boolean; unrefCalled: boolean; unref(): void }> = [];

  now = () => this.nowMs;
  setTimeout = (callback: () => void, delayMs: number) => {
    const timer = {
      due: this.nowMs + delayMs,
      callback,
      cleared: false,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    this.timers.push(timer);
    return timer as unknown as ReturnType<typeof setTimeout>;
  };
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => {
    (timer as unknown as { cleared: boolean }).cleared = true;
  };
  elapseWithoutRunningTimers(ms: number): void {
    this.nowMs += ms;
  }
  advance(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      const timer = this.timers
        .filter((candidate) => !candidate.cleared && candidate.due <= target)
        .sort((left, right) => left.due - right.due)[0];
      if (!timer) break;
      this.nowMs = timer.due;
      timer.cleared = true;
      timer.callback();
    }
    this.nowMs = target;
  }
}

test("exact pi-subagent ordinary, detached-like, cancellation, and replay fixtures never create native attention", async () => {
  const socket = await fixture();
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    const sessionId = "producer-fixture-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });

    // These are bounded, static fixtures of the public producer wire shape:
    // ordinary state, promoted/detached-like state, cancellation, and a ready
    // replay all carry attention:none. Foreground terminals now request the
    // same attention as background terminals and are covered with parent merge below.
    const fixtures = [
      producerUpdate(sessionId, 1),
      producerUpdate(sessionId, 2, { state: "running", counts: { active: 1, completed: 0, failed: 0, total: 1 } }),
      producerUpdate(sessionId, 3),
      producerUpdate(sessionId, 4, { state: "cancelled", counts: { active: 0, completed: 0, failed: 0, cancelled: 1, total: 1 } }),
      producerUpdate(sessionId, 5, { state: "cancelled", counts: { active: 0, completed: 0, failed: 0, cancelled: 1, total: 1 } }),
    ];
    for (const update of fixtures) runtime.handlePresenceUpdate(update);
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(notifications(socket.lines)).toEqual([]);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toEqual([]);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("three successful child deltas form one count-aware burst; cancellations stay out and a later burst is fresh", async () => {
  const socket = await fixture();
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    const sessionId = "three-success-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, { state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success" }));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, { state: "success", counts: { active: 0, completed: 2, failed: 0 }, attention: "success" }));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 4, { state: "cancelled", counts: { active: 0, completed: 2, failed: 0, cancelled: 1 }, attention: "none" }));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 5, { state: "success", counts: { active: 0, completed: 3, failed: 0, cancelled: 1 }, attention: "success" }));
    await waitFor(() => notifications(socket.lines).length === 1, 700);

    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Subagents completed", body: "3 completed" });
    expect(notifications(socket.lines)[0]?.params.body).not.toContain("cancelled");
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 6, { state: "success", counts: { active: 0, completed: 4, failed: 0, cancelled: 1 }, attention: "success" }));
    await waitFor(() => notifications(socket.lines).length === 2, 700);
    expect(notifications(socket.lines)[1]?.params).toMatchObject({ title: "Subagents completed", body: "1 completed" });
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("foreground success attention is held by its running parent until settlement and emits one combined notification", async () => {
  const socket = await fixture();
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    const sessionId = "parent-three-success-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    for (const [sequence, completed] of [[2, 1], [3, 2], [4, 3]] as const) {
      runtime.handlePresenceUpdate(producerUpdate(sessionId, sequence, {
        state: "success", counts: { active: 0, completed, failed: 0 }, attention: "success",
      }));
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(notifications(socket.lines)).toEqual([]);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toEqual([]);

    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Pi response ready", body: "Subagents: 3 completed" });
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("foreground error attention uses the active-parent max-wait and dispatches exactly one static alert and flash", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "error-max-wait-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.advance(100);
    expect(notifications(socket.lines)).toEqual([]);
    clock.advance(9_900);
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);

    expect(notifications(socket.lines)[0]?.params).toMatchObject({
      title: "Subagent failed",
      body: "1 failed · Parent is processing results",
    });
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    expect(clock.timers.every((timer) => timer.cleared || timer.unrefCalled)).toBe(true);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("a later active-parent error window cannot extend the first error's 10-second cap", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "late-window-error-cap-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.advance(9_999);
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "error", counts: { active: 0, completed: 0, failed: 2 }, attention: "error",
    }));
    expect(notifications(socket.lines)).toEqual([]);

    clock.advance(1);
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);
    expect(clock.nowMs).toBe(10_000);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({
      title: "Subagent failed",
      body: "2 failed · Parent is processing results",
    });
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);

    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(1);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("active-parent success and error windows close on schedule and settlement merges their later bursts", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "active-fixed-windows-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();

    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    clock.advance(450);
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "success", counts: { active: 0, completed: 2, failed: 0 }, attention: "success",
    }));
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    clock.advance(449);
    expect(notifications(socket.lines)).toEqual([]);
    clock.advance(1);
    await waitFor(() => notifications(socket.lines).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Pi response ready", body: "Subagents: 2 completed" });

    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 4, {
      state: "error", counts: { active: 0, completed: 2, failed: 1 }, attention: "error",
    }));
    clock.advance(100);
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 5, {
      state: "error", counts: { active: 0, completed: 2, failed: 2 }, attention: "error",
    }));
    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    clock.advance(99);
    expect(notifications(socket.lines)).toHaveLength(1);
    clock.advance(1);
    await waitFor(() => notifications(socket.lines).length === 2);
    expect(notifications(socket.lines)[1]?.params).toMatchObject({ title: "Subagents need attention", body: "2 failed" });
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("an expired inactive success grace dispatches before a new parent can claim it", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "expired-inactive-success-grace-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    clock.elapseWithoutRunningTimers(450);

    runtime.handleAgentStart();
    await waitFor(() => notifications(socket.lines).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Subagents completed", body: "1 completed" });
    expect(notifications(socket.lines)[0]?.params.title).not.toBe("Pi response ready");

    // The callback queued for the expired grace is fenced by the dispatch.
    clock.advance(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(1);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("an independent error remains independent when a parent starts inside its 100ms window", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "independent-error-window-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.advance(50);
    runtime.handleAgentStart();
    clock.advance(50);
    await waitFor(() => notifications(socket.lines).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Subagents need attention", body: "1 failed" });
    expect(clock.nowMs).toBe(100);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("an inactive error superseding pending success remains independent through a later parent start", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "superseding-independent-error-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    clock.advance(25);
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "error", counts: { active: 0, completed: 1, failed: 1 }, attention: "error",
    }));
    clock.advance(50);
    runtime.handleAgentStart();
    clock.advance(50);
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);

    expect(clock.nowMs).toBe(125);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({
      title: "Subagents need attention",
      body: "1 completed · 1 failed",
    });
    expect(JSON.stringify(notifications(socket.lines)[0]?.params)).not.toContain("Parent");
    expect(notifications(socket.lines)[0]?.params.title).not.toBe("Pi response ready");

    // The independent error must not create the active parent's 10-second
    // timeout fence, so its later terminal remains visible.
    clock.advance(10_000);
    expect(notifications(socket.lines)).toHaveLength(1);
    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 2);
    expect(notifications(socket.lines)[1]?.params.title).toBe("Pi");
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("an elapsed error hard cap fences before a later terminal can merge", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "elapsed-error-hard-cap-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.elapseWithoutRunningTimers(10_000);

    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "error", counts: { active: 0, completed: 0, failed: 2 }, attention: "error",
    }));
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({
      title: "Subagent failed",
      body: "1 failed · Parent is processing results",
    });

    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    clock.advance(100);
    await waitFor(() => notifications(socket.lines).length === 2
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 2);
    expect(notifications(socket.lines).map((notification) => notification.params)).toEqual([
      expect.objectContaining({ title: "Subagent failed", body: "1 failed · Parent is processing results" }),
      expect.objectContaining({ title: "Subagents need attention", body: "1 failed" }),
    ]);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(2);

    // Both the original hard-cap callback and the later aggregate timer are fenced.
    clock.advance(10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(2);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(2);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("an error max-wait fence suppresses only its own later parent settlement", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "error-timeout-fence-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.advance(10_000);
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);

    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(1);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);

    runtime.handleAgentStart();
    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 2
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 2);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(2);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("a cancelled parent reconciles a closed child success without carrying it into the next run", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "cancelled-parent-success-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    clock.advance(450);

    runtime.handleAgentEnd({ messages: [{ stopReason: "aborted" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Subagents completed", body: "1 completed" });

    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "success", counts: { active: 0, completed: 2, failed: 0 }, attention: "success",
    }));
    clock.advance(450);
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 2
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 2);
    expect(notifications(socket.lines)[1]?.params).toMatchObject({ title: "Pi response ready", body: "Subagents: 1 completed" });
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(2);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("a cancelled parent dispatches a closed child error once without a timeout duplicate", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "cancelled-parent-error-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.advance(100);

    runtime.handleAgentEnd({ messages: [{ stopReason: "aborted" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Subagents need attention", body: "1 failed" });
    clock.advance(10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(1);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(1);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("a later child error after a timeout fence settles independently while the parent error stays suppressed", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "fenced-later-child-error-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    clock.advance(10_000);
    await waitFor(() => notifications(socket.lines).length === 1
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 1);

    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "error", counts: { active: 0, completed: 0, failed: 2 }, attention: "error",
    }));
    runtime.handleAgentEnd({ messages: [{ stopReason: "error" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    clock.advance(100);
    await waitFor(() => notifications(socket.lines).length === 2
      && socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"')).length === 2);
    expect(notifications(socket.lines).map((notification) => notification.params)).toEqual([
      expect.objectContaining({ title: "Subagent failed", body: "1 failed · Parent is processing results" }),
      expect.objectContaining({ title: "Subagents need attention", body: "1 failed" }),
    ]);
    clock.advance(10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(2);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toHaveLength(2);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("a settled open aggregate dispatches at the next parent boundary instead of merging runs", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    const sessionId = "settled-open-boundary-session";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    clock.advance(100);
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });

    runtime.handleAgentStart();
    await waitFor(() => notifications(socket.lines).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Pi response ready", body: "Subagents: 1 completed" });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 3, {
      state: "success", counts: { active: 0, completed: 2, failed: 0 }, attention: "success",
    }));
    clock.advance(450);
    runtime.handleAgentEnd({ messages: [{ stopReason: "stop" }] });
    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 2);
    expect(notifications(socket.lines)[1]?.params).toMatchObject({ title: "Pi response ready", body: "Subagents: 1 completed" });
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("a delayed stale official-hook probe cannot overwrite the current session", async () => {
  const socket = await fixture();
  let resolveFirstProbe: ((value: boolean) => void) | undefined;
  let firstProbeStarted: (() => void) | undefined;
  const firstProbe = new Promise<boolean>((resolve) => { resolveFirstProbe = resolve; });
  const probeStarted = new Promise<void>((resolve) => { firstProbeStarted = resolve; });
  let probes = 0;
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(
      pi.api as never,
      resolvePresenceConfig(),
      undefined,
      () => {
        probes += 1;
        if (probes === 1) {
          firstProbeStarted?.();
          return firstProbe;
        }
        return Promise.resolve(true);
      },
    );
    const staleStart = runtime.startSession({ sessionManager: { getSessionId: () => "stale-hook-session" } });
    await probeStarted;
    await runtime.startSession({ sessionManager: { getSessionId: () => "current-hook-session" } });
    resolveFirstProbe?.(false);
    await staleStart;

    runtime.handleAgentStart();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(socket.lines.some((line) => line.startsWith("set_agent_lifecycle "))).toBe(false);
    expect(socket.lines.some((line) => line.startsWith("set_agent_pid "))).toBe(false);
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("notification and flash capabilities remain independently usable", async () => {
  const notifyOnly = await fixture(["notification.create_for_surface"]);
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    await runtime.startSession({ sessionManager: { getSessionId: () => "notify-only" } });
    runtime.handlePresenceUpdate({
      ...producerUpdate("notify-only", 1), source: { id: "external-notify", label: "External", kind: "task" }, state: "error", attention: "error",
    });
    await waitFor(() => notifications(notifyOnly.lines).length === 1);
    expect(notifyOnly.lines.some((line) => line.includes('"method":"surface.trigger_flash"'))).toBe(false);
    await runtime.shutdownSession();
  } finally {
    await notifyOnly.cleanup();
  }

  const flashOnly = await fixture(["surface.trigger_flash"]);
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    await runtime.startSession({ sessionManager: { getSessionId: () => "flash-only" } });
    runtime.handlePresenceUpdate({
      ...producerUpdate("flash-only", 1), source: { id: "external-flash", label: "External", kind: "task" }, state: "error", attention: "error",
    });
    await waitFor(() => flashOnly.lines.some((line) => line.includes('"method":"surface.trigger_flash"')));
    expect(notifications(flashOnly.lines)).toEqual([]);
    await runtime.shutdownSession();
  } finally {
    await flashOnly.cleanup();
  }
});

test("replacement and shutdown fence pending child success and error callbacks", async () => {
  const socket = await fixture();
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig(), clock);
    await runtime.startSession({ sessionManager: { getSessionId: () => "old-session" } });
    runtime.handlePresenceUpdate(producerUpdate("old-session", 1));
    runtime.handlePresenceUpdate(producerUpdate("old-session", 2, {
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    await runtime.startSession({ sessionManager: { getSessionId: () => "replacement-session" } });
    clock.advance(500);

    runtime.handlePresenceUpdate(producerUpdate("replacement-session", 1));
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(producerUpdate("replacement-session", 2, {
      state: "error", counts: { active: 0, completed: 0, failed: 1 }, attention: "error",
    }));
    await runtime.shutdownSession();
    clock.advance(10_000);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toEqual([]);
    expect(socket.lines.filter((line) => line.includes('"method":"surface.trigger_flash"'))).toEqual([]);
  } finally {
    await socket.cleanup();
  }
});

test("aggregate notifications exclude producer and payload canaries; invalid raw payloads are silent", async () => {
  const socket = await fixture();
  const originalError = console.error;
  const consoleCalls: unknown[][] = [];
  console.error = (...args: unknown[]) => { consoleCalls.push(args); };
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    const sessionId = "session-CANARY-3d6f0a78-1111-4222-8333-abcdefabcdef";
    const canaries = ["TASK_CANARY", "/private/PATH_CANARY", "RAW_OUTPUT_CANARY", "RAW_ERROR_CANARY", "MODEL_CANARY", sessionId, "3d6f0a78-1111-4222-8333-abcdefabcdef"];
    const canarySource = {
      id: "pi-subagent",
      label: "TASK_CANARY /private/PATH_CANARY RAW_OUTPUT_CANARY RAW_ERROR_CANARY",
      kind: "MODEL_CANARY 3d6f0a78-1111-4222-8333-abcdefabcdef",
    };
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 1, { source: canarySource }));
    runtime.handlePresenceUpdate(producerUpdate(sessionId, 2, {
      source: canarySource,
      state: "success", counts: { active: 0, completed: 1, failed: 0 }, attention: "success",
    }));
    await waitFor(() => notifications(socket.lines).length === 1, 700);
    const aggregate = JSON.stringify(notifications(socket.lines)[0]);
    for (const canary of canaries) expect(aggregate).not.toContain(canary);

    runtime.handlePresenceUpdate({
      ...producerUpdate(sessionId, 3),
      source: { id: "pi-subagent", label: "bad\u202e-label", kind: "agent-group" },
    });
    runtime.handlePresenceUpdate({
      ...producerUpdate(sessionId, 4),
      output: "RAW_OUTPUT_CANARY",
      error: "RAW_ERROR_CANARY",
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(consoleCalls).toEqual([]);
    expect(notifications(socket.lines)).toHaveLength(1);
    await runtime.shutdownSession();
  } finally {
    console.error = originalError;
    await socket.cleanup();
  }
});

test("notification RPC failure has no unhandled rejection and does not block status or teardown", async () => {
  const socket = await fixture(["notification.create_for_surface"]);
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", listener);
  try {
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, resolvePresenceConfig());
    const sessionId = "RPC_FAIL";
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handlePresenceUpdate({
      ...producerUpdate(sessionId, 1),
      source: { id: "external-rpc-failure", label: "RPC_FAIL", kind: "task" },
      state: "error",
      attention: "error",
    });
    await waitFor(() => socket.lines.some((line) => line.startsWith("set_status "))
      && socket.lines.some((line) => line.includes('"method":"notification.create_for_surface"')));
    await runtime.shutdownSession();
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(unhandled).toEqual([]);
    expect(socket.lines).toContain(`clear_status ${presenceStatusKey("external-rpc-failure", socket.surfaceId)} --tab=${socket.workspaceId}`);
  } finally {
    process.off("unhandledRejection", listener);
    await socket.cleanup();
  }
});

test("local terminal wording is static, settles once after idle, and clears its sidebar status on schedule", async () => {
  const socket = await fixture(["notification.create_for_surface"]);
  try {
    const clock = new ManualRuntimeClock();
    const pi = fakePi();
    const runtime = new PresenceRuntime(pi.api as never, {
      ...resolvePresenceConfig(),
      finalClearMs: 25,
    }, clock);
    const sessionId = "canonical-local-session";
    const canaries = ["ASSISTANT_BODY_CANARY", "PROMPT_CANARY", "RAW_ERROR_CANARY", "/private/PATH_CANARY", "TOOL_OUTPUT_CANARY"];
    await runtime.startSession({ sessionManager: { getSessionId: () => sessionId } });
    runtime.handleAgentStart();
    runtime.handleMessageEnd({ message: {
      role: "assistant",
      content: "ASSISTANT_BODY_CANARY",
      preview: "PROMPT_CANARY",
      error: "RAW_ERROR_CANARY",
      path: "/private/PATH_CANARY",
      toolOutput: "TOOL_OUTPUT_CANARY",
    } });
    runtime.handleAgentEnd({ messages: [{ stopReason: "error", error: "RAW_ERROR_CANARY" }] });
    runtime.handleAgentSettled({ isIdle: () => false });
    expect(notifications(socket.lines)).toEqual([]);

    runtime.handleAgentSettled({ isIdle: () => true });
    await waitFor(() => notifications(socket.lines).length === 1);
    expect(notifications(socket.lines)[0]?.params).toMatchObject({ title: "Pi", body: "Needs attention" });
    runtime.handleAgentSettled({ isIdle: () => true });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(notifications(socket.lines)).toHaveLength(1);
    for (const canary of canaries) expect(socket.lines.join("\n")).not.toContain(canary);

    const localKey = presenceStatusKey("pi", socket.surfaceId);
    clock.advance(24);
    expect(socket.lines).not.toContain(`clear_status ${localKey} --tab=${socket.workspaceId}`);
    clock.advance(1);
    await waitFor(() => socket.lines.includes(`clear_status ${localKey} --tab=${socket.workspaceId}`));
    await runtime.shutdownSession();
  } finally {
    await socket.cleanup();
  }
});

test("presence status keys use their documented namespace and remain distinct from locally evidenced source-style keys", () => {
  const key = presenceStatusKey("pi-subagent", "00000000-0000-4000-8000-000000000012");
  // Bounded static evidence only: these are local Pi/status/meta/log source
  // identifiers, not a claim about unavailable live pi-cmux key allocation.
  expect(key).toMatch(/^pi-presence:[a-f0-9]{64}$/);
  expect([...new Set([key, "pi", "pi-subagent", "pi-presence", "pi-cmux-presence"])]).toHaveLength(5);
});
