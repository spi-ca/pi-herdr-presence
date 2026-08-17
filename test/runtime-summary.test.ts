import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { PresenceRuntime } from "../src/runtime.js";
import { resolvePresenceConfig } from "../src/config.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const REQUEST_TIMEOUT_MS = 1_000;
const STALE_REPLAY_QUIET_MS = 25;
type MetadataTokens = Record<string, string | null | undefined>;
type SocketRequest = { id: string; method?: string; params?: { tokens?: MetadataTokens } };
type RequestWaiter = { after: number; predicate: (request: SocketRequest) => boolean; description: string; resolve: (request: SocketRequest) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type QuietWaiter = { after: number; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

class RequestBarrier {
  private readonly requests: SocketRequest[] = [];
  private readonly requestWaiters = new Set<RequestWaiter>();
  private readonly quietWaiters = new Set<QuietWaiter>();

  record(line: string): SocketRequest {
    const request = JSON.parse(line) as SocketRequest;
    this.requests.push(request);
    const index = this.requests.length - 1;
    for (const waiter of [...this.requestWaiters]) if (index >= waiter.after && waiter.predicate(request)) this.finishRequest(waiter, request);
    for (const waiter of [...this.quietWaiters]) if (index >= waiter.after) this.finishQuiet(waiter, new Error(`Unexpected socket request while waiting for queue silence: ${request.method ?? "unknown"}.`));
    return request;
  }

  count(): number { return this.requests.length; }

  metadataTokens(): Array<MetadataTokens | undefined> {
    return this.requests.filter((request) => request.method === "pane.report_metadata").map((request) => request.params?.tokens);
  }

  metadata(predicate: (tokens: MetadataTokens) => boolean, description: string, after = 0): Promise<SocketRequest> {
    return this.waitFor((request) => request.method === "pane.report_metadata" && predicate(request.params?.tokens ?? {}), description, after);
  }

  async expectNoNewRequests(after: number, timeoutMs = STALE_REPLAY_QUIET_MS): Promise<void> {
    if (this.requests.length > after) throw new Error("Socket queue was not drained before the stale-replay check.");
    await new Promise<void>((resolve, reject) => {
      const waiter: QuietWaiter = {
        after,
        resolve,
        reject,
        timer: setTimeout(() => this.finishQuiet(waiter), timeoutMs),
      };
      this.quietWaiters.add(waiter);
    });
  }

  close(): void {
    for (const waiter of [...this.requestWaiters]) this.finishRequest(waiter, new Error("Request barrier closed before its request was observed."));
    for (const waiter of [...this.quietWaiters]) this.finishQuiet(waiter, new Error("Request barrier closed before its silence window completed."));
  }

  private waitFor(predicate: (request: SocketRequest) => boolean, description: string, after: number): Promise<SocketRequest> {
    const existing = this.requests.slice(after).find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<SocketRequest>((resolve, reject) => {
      const waiter: RequestWaiter = {
        after,
        predicate,
        description,
        resolve,
        reject,
        timer: setTimeout(() => this.finishRequest(waiter, new Error(`Timed out waiting for ${description}.`)), REQUEST_TIMEOUT_MS),
      };
      this.requestWaiters.add(waiter);
    });
  }

  private finishRequest(waiter: RequestWaiter, result: SocketRequest | Error): void {
    if (!this.requestWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (result instanceof Error) waiter.reject(result); else waiter.resolve(result);
  }

  private finishQuiet(waiter: QuietWaiter, error?: Error): void {
    if (!this.quietWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (error) waiter.reject(error); else waiter.resolve();
  }
}

const update = (sequence: number, generation = 1) => ({ version: 1 as const, sessionId: "session", generation, sequence, source: { id: "pi-subagent", label: "Subagents", kind: "aggregate" }, state: "running" as const, counts: { active: 1, completed: 0, failed: 0 } });
const summary = (sequence: number, generation = 1) => ({ version: 1 as const, sessionId: "session", generation, sequence, source: { id: "pi-subagent" }, active: [{ id: "opaque", agent: "worker", status: "running" as const, category: "active" as const, startedAt: 1 }], terminal: { id: "opaque", agent: "worker", status: "completed" as const, completedAt: 2 }, omitted: 0 });

async function withRuntime(run: (runtime: PresenceRuntime, requests: RequestBarrier) => Promise<void>, finalClearMs = 20) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-summary-")); const socket = join(dir, "socket"); const requests = new RequestBarrier();
  const server = await fakeSocket(socket, (line) => { const request = requests.record(line); return JSON.stringify({ id: request.id, result: {} }); });
  const keys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"]; const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(dir, "missing") });
    const runtime = new PresenceRuntime({ getAllTools() { return []; }, events: { emit() {} } } as never, { ...resolvePresenceConfig(), finalClearMs });
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    await run(runtime, requests);
    await runtime.shutdownSession();
  } finally { requests.close(); for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await server.close(); await fs.rm(dir, { recursive: true, force: true }); }
}

test("summary metadata clears on terminal timeout and accepted remove", async () => {
  await withRuntime(async (runtime, requests) => {
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    await requests.metadata((tokens) => tokens.subagents === "1" && tokens.subagent_terminal === "completed", "summary metadata");
    runtime.handlePresenceRemove({ version: 1, sessionId: "session", generation: 1, sequence: 2, source: { id: "pi-subagent" } });
    await requests.metadata((tokens) => tokens.subagents === null && tokens.subagent_terminal === null, "remove-clear metadata");
    const metadata = requests.metadataTokens();
    expect(metadata.some((tokens) => tokens?.subagents === "1" && tokens.subagent_terminal === "completed")).toBe(true);
    expect(metadata.at(-1)).toMatchObject({ subagents: null, subagent_terminal: null });
  });
});

test("remove tombstones reject stale summary replay and allow a newer companion", async () => {
  await withRuntime(async (runtime, requests) => {
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    await requests.metadata((tokens) => tokens.subagents === "1", "initial summary metadata");
    runtime.handlePresenceRemove({ version: 1, sessionId: "session", generation: 1, sequence: 2, source: { id: "pi-subagent" } });
    await requests.metadata((tokens) => tokens.subagents === null && tokens.subagent_terminal === null, "remove-clear metadata");
    const afterRemove = requests.count();
    runtime.handleSubagentSummary(summary(1));
    await requests.expectNoNewRequests(afterRemove);
    runtime.handlePresenceUpdate(update(3));
    runtime.handleSubagentSummary(summary(3));
    await requests.metadata((tokens) => tokens.subagents === "1", "newer summary metadata", afterRemove);
    const metadata = requests.metadataTokens();
    expect(metadata.at(-1)).toMatchObject({ subagents: "1" });
  });
});

test("summary terminal expiry registry refreshes LRU recency without extending deadlines", async () => {
  const runtime = new PresenceRuntime({ getAllTools() { return []; }, events: { emit() {} } } as never, { ...resolvePresenceConfig(), finalClearMs: 60_000 });
  const internal = runtime as unknown as { retainSummaryTerminal(value: ReturnType<typeof summary>): unknown; summaryTerminalExpiry: Map<string, number> };
  const value = (id: number) => ({ ...summary(1), terminal: { ...summary(1).terminal, id: `terminal-${id}`, completedAt: id } });
  for (let id = 0; id < 64; id++) internal.retainSummaryTerminal(value(id));
  const firstKey = [...internal.summaryTerminalExpiry.keys()][0]!;
  const firstDeadline = internal.summaryTerminalExpiry.get(firstKey);
  internal.retainSummaryTerminal(value(0));
  internal.retainSummaryTerminal(value(64));
  expect(internal.summaryTerminalExpiry.size).toBe(64);
  expect(internal.summaryTerminalExpiry.get(firstKey)).toBe(firstDeadline);
  expect([...internal.summaryTerminalExpiry.keys()].some((key) => key.startsWith("terminal-1\u0000"))).toBe(false);
  await runtime.shutdownSession();
});

test("accepted remove gives the same terminal identity a fresh retention window", async () => {
  await withRuntime(async (runtime) => {
    const internal = runtime as unknown as { summaryTerminalExpiry: Map<string, number> };
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    const identity = [...internal.summaryTerminalExpiry.keys()][0]!;
    expect(internal.summaryTerminalExpiry.get(identity)).toBeDefined();
    runtime.handlePresenceRemove({ version: 1, sessionId: "session", generation: 1, sequence: 2, source: { id: "pi-subagent" } });
    expect(internal.summaryTerminalExpiry.size).toBe(0);
    const renewedAt = Date.now();
    runtime.handlePresenceUpdate(update(3));
    runtime.handleSubagentSummary(summary(3));
    const renewedDeadline = internal.summaryTerminalExpiry.get(identity);
    expect(renewedDeadline).toBeGreaterThanOrEqual(renewedAt + 60_000);
    expect(renewedDeadline).toBeLessThanOrEqual(Date.now() + 60_000);
  }, 60_000);
});

test("accepted generation change gives the same terminal identity a fresh retention window", async () => {
  await withRuntime(async (runtime) => {
    const internal = runtime as unknown as { summaryTerminalExpiry: Map<string, number> };
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    const identity = [...internal.summaryTerminalExpiry.keys()][0]!;
    expect(internal.summaryTerminalExpiry.get(identity)).toBeDefined();
    runtime.handlePresenceUpdate(update(1, 2));
    expect(internal.summaryTerminalExpiry.size).toBe(0);
    const renewedAt = Date.now();
    runtime.handleSubagentSummary(summary(1, 2));
    const renewedDeadline = internal.summaryTerminalExpiry.get(identity);
    expect(renewedDeadline).toBeGreaterThanOrEqual(renewedAt + 60_000);
    expect(renewedDeadline).toBeLessThanOrEqual(Date.now() + 60_000);
  }, 60_000);
});

test("summary companion is one-shot and a terminal identity has a fixed expiry", async () => {
  await withRuntime(async (runtime, requests) => {
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    await requests.metadata((tokens) => tokens.subagents === "1" && tokens.subagent_terminal === "completed", "initial terminal metadata");
    runtime.handleSubagentSummary(summary(1)); // Same-sequence replay is rejected.
    runtime.handlePresenceUpdate(update(2));
    const afterNewerUpdate = requests.count();
    runtime.handleSubagentSummary(summary(2)); // Same terminal identity must not extend its first deadline.
    await requests.metadata((tokens) => tokens.subagents === "1" && tokens.subagent_terminal === null && tokens.subagent_terminal_at === null, "terminal-null metadata", afterNewerUpdate);
    const metadata = requests.metadataTokens();
    expect(metadata.at(-1)).toMatchObject({ subagents: "1", subagent_terminal: null, subagent_terminal_at: null });
  });
});
