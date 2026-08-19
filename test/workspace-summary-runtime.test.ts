import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { resolvePresenceConfig } from "../src/config.js";
import { PresenceRuntime } from "../src/runtime.js";
import { paneInfo } from "./fixtures/pane-info.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_WORKSPACE_ID", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"] as const;
const context = (id: string) => ({ mode: "tui", sessionManager: { getSessionId: () => id }, isIdle: () => true });
const restore = (saved: Record<string, string | undefined>) => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } };

async function workspaceRuntime(name: string, handler: (request: Request) => string | Promise<string>) {
  const directory = await fs.mkdtemp(join(os.tmpdir(), name));
  const socket = join(directory, "socket");
  const server = await fakeSocket(socket, async (line) => handler(JSON.parse(line) as Request));
  const saved = Object.fromEntries(environmentKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_WORKSPACE_ID: "workspace", HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "absent") });
  let runtime: PresenceRuntime | undefined;
  const events = { on() {}, emit(name: unknown, payload: unknown) { runtime?.handlePresenceEvent(name, payload); } };
  runtime = new PresenceRuntime({ getAllTools: () => [], events } as never, resolvePresenceConfig());
  return { directory, runtime, server, saved };
}

test("runtime publishes and refreshes the leased workspace summary, then stops its heartbeat on teardown", async () => {
  const requests: Request[] = [];
  const fixture = await workspaceRuntime("herdr-workspace-heartbeat-", (request) => {
    requests.push(request);
    return JSON.stringify({ id: request.id, result: request.method === "pane.list" ? { type: "pane_list", panes: [paneInfo()] } : { type: "ok" } });
  });
  const { runtime } = fixture;
  try {
    const sessionContext = context("session");
    await runtime.startSession(sessionContext);
    expect(requests.filter(request => request.method === "workspace.report_metadata").at(-1)?.params.tokens).toEqual({ main_summary: "idle" });
    expect((runtime as unknown as { workspaceHeartbeatTimer: unknown }).workspaceHeartbeatTimer).toBeDefined();

    runtime.handleAgentStart(sessionContext);
    await new Promise(resolve => setTimeout(resolve, 20));
    await (runtime as unknown as { publishWorkspaceMainSummary(): Promise<void> }).publishWorkspaceMainSummary();
    expect(requests.filter(request => request.method === "workspace.report_metadata").at(-1)?.params.tokens).toEqual({ main_summary: "working" });

    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    const workspaceCount = requests.filter(request => request.method === "workspace.report_metadata").length;
    await (runtime as unknown as { publishWorkspaceMainSummary(): Promise<void> }).publishWorkspaceMainSummary();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(workspaceCount);
    expect((runtime as unknown as { workspaceHeartbeatTimer: unknown }).workspaceHeartbeatTimer).toBeUndefined();
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
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
  try {
    const initial = runtime.startSession(context("first"));
    await seenFirst;
    const replacement = runtime.startSession(context("second"));
    releaseFirst();
    await seenSecond;
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(0);
    releaseSecond();
    await Promise.all([initial, replacement]);
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(1);
  } finally {
    releaseFirst?.();
    releaseSecond?.();
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(fixture.saved);
    await fixture.server.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});

test("valid shutdown fences a stalled workspace list before it can write", async () => {
  const requests: Request[] = [];
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
  });
  const { runtime } = fixture;
  try {
    await runtime.startSession(context("session"));
    const reportsBefore = requests.filter(request => request.method === "workspace.report_metadata").length;
    const refresh = (runtime as unknown as { publishWorkspaceMainSummary(): Promise<void> }).publishWorkspaceMainSummary();
    await seenStalled;
    const shutdown = runtime.shutdownSession((runtime as unknown as { context: object }).context);
    release();
    await refresh;
    await shutdown;
    expect(requests.filter(request => request.method === "workspace.report_metadata")).toHaveLength(reportsBefore);
  } finally {
    release?.();
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    restore(fixture.saved);
    await fixture.server.close();
    await fs.rm(fixture.directory, { recursive: true, force: true });
  }
});
