import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { PresenceClient } from "../src/client.js";
import { resolvePresenceConfig } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
type Context = { mode: "tui"; sessionManager: { getSessionId(): string }; isIdle(): boolean };
const envKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"] as const;

/** Observable subset of pinned Herdr 0.9.5 for a process-confirmed Pi pane:
 * a recognized session report followed by a state report establishes identity;
 * HookClear prevents same-ID state acceptance even after a mapped resume report.
 * Intermediate staging/sequence state and unavailable/delayed process detection
 * are deliberately not modeled. This is not a full Herdr implementation. */
function anchorFixture() {
  let persisted: string | null = null;
  let acceptedState: string | null = null;
  let suppressed: string | null = null;
  const requests: Request[] = [];
  function accept(request: Request) {
    requests.push(request);
    const { method, params } = request;
    if (method === "pane.clear_agent_authority") {
      suppressed = persisted;
      persisted = null;
      acceptedState = null;
    } else if (method === "pane.report_agent_session") {
      const id = params.agent_session_id as string;
      const reason = params.session_start_source;
      if (id !== suppressed && (persisted === id || ["startup", "clear", "resume", "compact", "new", "fork", "select"].includes(reason as string))) persisted = id;
    } else if (method === "pane.report_agent" && params.agent_session_id === persisted && persisted !== suppressed) {
      acceptedState = params.state as string;
    }
  }
  return { accept, requests, get persisted() { return persisted; }, get acceptedState() { return acceptedState; } };
}

async function scenario(run: (h: {
  runtime: PresenceRuntime; hooks: Map<string, (event: unknown, context: Context) => unknown>;
  makeRuntime(): PresenceRuntime; anchor: ReturnType<typeof anchorFixture>; context(id: string, idle?: boolean): Context;
}) => Promise<void>, companion = false, stallProjection = false, rejectSession = false, stallReloadCleanup: boolean | "brief" = false) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-reload-continuity-"));
  const path = join(dir, "socket");
  const anchor = anchorFixture();
  const server = await fakeSocket(path, async line => {
    const request = JSON.parse(line) as Request;
    anchor.accept(request);
    if (stallProjection && request.method === "pane.report_agent") return undefined;
    if (stallReloadCleanup && request.method === "pane.report_metadata" && request.params.clear_title === true
      && anchor.requests.some(r => r.method === "pane.report_agent_session")) {
      if (stallReloadCleanup === "brief") await new Promise(resolve => setTimeout(resolve, 100));
      else return undefined;
    }
    if (rejectSession && request.method === "pane.report_agent_session") return "invalid response";
    return JSON.stringify({ id: request.id, result: {} });
  });
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const runtimes: PresenceRuntime[] = [];
  const hooks = new Map<string, (event: unknown, context: Context) => unknown>();
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const bus = {
    getAllTools: () => [],
    on(name: string, listener: (event: unknown, context: Context) => unknown) { hooks.set(name, listener); },
    events: {
      on(name: string, listener: (payload: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
      emit(name: string, payload: unknown) { for (const listener of listeners.get(name) ?? []) listener(payload); },
    },
  };
  const makeRuntime = () => {
    const runtime = new PresenceRuntime(bus as never, { ...resolvePresenceConfig(), soleReporter: true, metadata: false, timeoutMs: 500 });
    runtimes.push(runtime);
    registerPresenceHooks(bus as never, runtime);
    return runtime;
  };
  const context = (id: string, idle = true): Context => ({ mode: "tui", sessionManager: { getSessionId: () => id }, isIdle: () => idle });
  try {
    if (companion) {
      await fs.mkdir(join(dir, "agent", "extensions"), { recursive: true });
      await fs.writeFile(join(dir, "agent", "extensions", "herdr-agent-state.ts"), "HERDR_INTEGRATION_ID=pi");
    }
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: path, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: companion ? join(dir, "agent") : join(dir, "missing") });
    await run({ runtime: makeRuntime(), hooks, makeRuntime, anchor, context });
  } finally {
    for (const runtime of runtimes) {
      const manager = (runtime as unknown as { sessionManager: Context["sessionManager"] | null }).sessionManager;
      if (manager) await runtime.shutdownSession({ sessionManager: manager });
    }
    for (const key of envKeys) {
      const value = saved[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error("expected socket state was not reached");
}

for (const idle of [true, false]) {
  test(`cache-busted ${idle ? "idle" : "active"} reload keeps the same accepted session and state`, async () => {
    await scenario(async ({ runtime, hooks, makeRuntime, anchor, context }) => {
      const first = context("same", idle);
      await runtime.startSession(first, { reason: "startup" });
      expect(anchor.persisted).toBe("same");
      await until(() => anchor.acceptedState === (idle ? "idle" : "working"));
      await hooks.get("session_shutdown")!({ reason: "reload" }, first);
      expect(anchor.persisted).toBe("same");
      expect(anchor.requests.some(r => r.method === "pane.clear_agent_authority")).toBe(false);
      const next = makeRuntime();
      await next.startSession({ ...first }, { reason: "reload" });
      expect(anchor.requests.filter(r => r.method === "pane.report_agent_session").at(-1)?.params.session_start_source).toBe("resume");
      expect(anchor.persisted).toBe("same");
      await until(() => anchor.acceptedState === (idle ? "idle" : "working"));
    });
  });
}

test("mapping a reload to resume cannot repair a HookClear for the same ID", () => {
  const anchor = anchorFixture();
  const request = (method: string, params: Record<string, unknown>): Request => ({ id: "fixture", method, params });
  anchor.accept(request("pane.report_agent_session", { agent_session_id: "same", session_start_source: "startup" }));
  anchor.accept(request("pane.report_agent", { agent_session_id: "same", state: "idle" }));
  anchor.accept(request("pane.clear_agent_authority", {}));
  anchor.accept(request("pane.report_agent_session", { agent_session_id: "same", session_start_source: "resume" }));
  anchor.accept(request("pane.report_agent", { agent_session_id: "same", state: "working" }));
  expect(anchor.persisted).toBeNull();
  expect(anchor.acceptedState).toBeNull();
});

test("same-runtime reload retains only lifecycle authority, clears presentation, and fences old output", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const before = anchor.requests.length;
    await runtime.startSession({ ...first }, { reason: "reload" });
    expect(anchor.persisted).toBe("same");
    expect(anchor.requests.slice(before).some(r => r.method === "pane.clear_agent_authority")).toBe(false);
    expect(anchor.requests.slice(before).some(r => r.method === "pane.report_metadata" && r.params.clear_title === true)).toBe(true);
    expect(anchor.requests.filter(r => r.method === "pane.report_agent_session").at(-1)?.params.session_start_source).toBe("resume");
  });
});

test("queued hook reload shutdown superseded by same-owner quit rolls back authority", async () => {
  await scenario(async ({ runtime, hooks, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    await Promise.all([
      hooks.get("session_shutdown")!({ reason: "reload" }, first),
      hooks.get("session_shutdown")!({ reason: "quit" }, { ...first }),
    ]);
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    expect(anchor.persisted).toBeNull();
  });
});

test("in-flight hook reload shutdown superseded by same-owner quit rolls back authority", async () => {
  await scenario(async ({ runtime, hooks, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const before = anchor.requests.length;
    const reload = hooks.get("session_shutdown")!({ reason: "reload" }, first);
    await until(() => anchor.requests.slice(before).some(r => r.method === "pane.report_metadata" && r.params.clear_title === true));
    const quit = hooks.get("session_shutdown")!({ reason: "quit" }, { ...first });
    await Promise.all([reload, quit]);
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    expect(anchor.persisted).toBeNull();
  }, false, false, false, "brief");
});

test("only the captured reload shutdown owner can cancel preservation", async () => {
  for (const kind of ["manager", "id", "reload", "missing"] as const) {
    await scenario(async ({ runtime, hooks, anchor, context }) => {
      const first = context("same");
      let id = "same";
      first.sessionManager.getSessionId = () => id;
      await runtime.startSession(first, { reason: "startup" });
      const reload = hooks.get("session_shutdown")!({ reason: "reload" }, first);
      if (kind === "id") id = "other";
      const other = kind === "manager" ? context("same") : { ...first };
      await hooks.get("session_shutdown")!({ reason: kind === "reload" ? "reload" : kind === "missing" ? undefined : "quit" }, other);
      await reload;
      expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(0);
      expect(anchor.persisted).toBe("same");
    });
  }
});

test("a queued same-runtime reload superseded by quit rolls back authority", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const reload = runtime.startSession({ ...first }, { reason: "reload" });
    const quit = runtime.shutdownSession(first, "quit");
    await Promise.all([reload, quit]);
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    expect(anchor.persisted).toBeNull();
  });
});

test("a queued same-runtime reload superseded by replacement retires prior authority", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const reload = runtime.startSession({ ...first }, { reason: "reload" });
    const replacement = runtime.startSession(context("next"), { reason: "new" });
    await Promise.all([reload, replacement]);
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    expect(anchor.persisted).toBe("next");
  });
});

test("a second queued reload cannot inherit the first reload's preservation", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const earlier = runtime.startSession({ ...first }, { reason: "reload" });
    const latest = runtime.startSession({ ...first }, { reason: "reload" });
    await Promise.all([earlier, latest]);
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    expect(anchor.persisted).toBeNull();
  });
});

test("expired preservation rollback does not send or create a fresh deadline", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const before = anchor.requests.length;
    await PresenceClient.rollbackPreservedAuthorityOnce(
      { paneId: "pane", workspaceId: "workspace", socketPath: process.env.HERDR_SOCKET_PATH! },
      { ...resolvePresenceConfig(), timeoutMs: 500 },
      Date.now() - 1,
    );
    expect(anchor.requests).toHaveLength(before);
    expect(anchor.persisted).toBe("same");
  });
});

test("quit during preserving reload cleanup still rolls back retained authority", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const before = anchor.requests.length;
    const reload = runtime.startSession({ ...first }, { reason: "reload" });
    await until(() => anchor.requests.slice(before).some(r => r.method === "pane.report_metadata" && r.params.clear_title === true));
    const quit = runtime.shutdownSession(first, "quit");
    await Promise.all([reload, quit]);
    await until(() => anchor.requests.some(r => r.method === "pane.clear_agent_authority"));
    expect(anchor.persisted).toBeNull();
  }, false, false, false, true);
});

test("replacement during preserving reload cleanup clears old authority before claiming new", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    const before = anchor.requests.length;
    const reload = runtime.startSession({ ...first }, { reason: "reload" });
    await until(() => anchor.requests.slice(before).some(r => r.method === "pane.report_metadata" && r.params.clear_title === true));
    const replacement = runtime.startSession(context("next"), { reason: "new" });
    await Promise.all([reload, replacement]);
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    expect(anchor.persisted).toBe("next");
  }, false, false, false, true);
});

test("quit, unknown reason and direct shutdown keep authority rollback", async () => {
  for (const reason of ["quit", "unexpected", undefined]) {
    await scenario(async ({ runtime, anchor, context }) => {
      const first = context("same");
      await runtime.startSession(first, { reason: "startup" });
      await runtime.shutdownSession(first, reason);
      expect(anchor.persisted).toBeNull();
      expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(1);
    });
  }
});

test("reload with mutated ID or different manager clears rather than retaining", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    let id = "original";
    const manager = { getSessionId: () => id };
    const first = { ...context("original"), sessionManager: manager };
    await runtime.startSession(first, { reason: "startup" });
    id = "forked";
    await runtime.shutdownSession(first, "reload");
    expect(anchor.persisted).toBeNull();
  });
  for (const changed of ["manager", "id"] as const) {
    await scenario(async ({ runtime, anchor, context }) => {
      let id = "original";
      const first = context("original");
      first.sessionManager.getSessionId = () => id;
      await runtime.startSession(first, { reason: "startup" });
      if (changed === "id") id = "next";
      const next = changed === "manager" ? context("original") : { ...first };
      await runtime.startSession(next, { reason: "reload" });
      expect(anchor.requests.some(r => r.method === "pane.clear_agent_authority")).toBe(true);
    });
  }
});

test("companion reload never reports or clears lifecycle authority", async () => {
  await scenario(async ({ runtime, hooks, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    await hooks.get("session_shutdown")!({ reason: "reload" }, first);
    expect(anchor.requests.some(r => r.method === "pane.report_agent_session" || r.method === "pane.report_agent" || r.method === "pane.clear_agent_authority")).toBe(false);
    expect(anchor.requests.some(r => r.method === "pane.report_metadata" && r.params.source === "herdr:pi-presence" && r.params.clear_title === true)).toBe(true);
  }, true);
});

test("reload during unfinished startup still rolls back attempted authority", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    const starting = runtime.startSession(first, { reason: "startup" });
    await until(() => anchor.requests.some(r => r.method === "pane.report_agent"));
    await runtime.shutdownSession(first, "reload");
    await starting;
    expect(anchor.requests.some(r => r.method === "pane.report_agent_session")).toBe(true);
    expect(anchor.requests.some(r => r.method === "pane.clear_agent_authority")).toBe(true);
    expect(anchor.persisted).toBeNull();
  }, false, true);
});

test("unacknowledged session report cannot opt in even after projection completes", async () => {
  await scenario(async ({ runtime, anchor, context }) => {
    const first = context("same");
    await runtime.startSession(first, { reason: "startup" });
    expect(anchor.requests.some(r => r.method === "pane.report_agent")).toBe(true);
    await runtime.shutdownSession(first, "reload");
    expect(anchor.requests.some(r => r.method === "pane.clear_agent_authority")).toBe(true);
    expect(anchor.persisted).toBeNull();
  }, false, false, true);
});

test("new, resume and fork starts retire prior authority instead of preserving it", async () => {
  for (const reason of ["new", "resume", "fork"]) {
    await scenario(async ({ runtime, anchor, context }) => {
      const first = context("original");
      await runtime.startSession(first, { reason: "startup" });
      await runtime.startSession(context("replacement"), { reason });
      expect(anchor.requests.some(r => r.method === "pane.clear_agent_authority")).toBe(true);
      expect(anchor.persisted).toBe("replacement");
    });
  }
});

test("a stale cache-busted runtime never clears its replacement", async () => {
  await scenario(async ({ runtime, makeRuntime, anchor, context }) => {
    const first = context("original");
    await runtime.startSession(first, { reason: "startup" });
    await runtime.shutdownSession(first, "reload");
    const replacement = makeRuntime();
    await replacement.startSession({ ...first }, { reason: "reload" });
    const before = anchor.requests.filter(r => r.method === "pane.clear_agent_authority").length;
    await runtime.shutdownSession(first, "reload");
    await runtime.shutdownSession(first, "quit");
    expect(anchor.requests.filter(r => r.method === "pane.clear_agent_authority")).toHaveLength(before);
    expect(anchor.persisted).toBe("original");
  });
});
