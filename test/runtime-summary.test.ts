import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { PresenceRuntime } from "../src/runtime.js";
import { resolvePresenceConfig } from "../src/config.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const update = (sequence: number, generation = 1) => ({ version: 1 as const, sessionId: "session", generation, sequence, source: { id: "pi-subagent", label: "Subagents", kind: "aggregate" }, state: "running" as const, counts: { active: 1, completed: 0, failed: 0 } });
const summary = (sequence: number, generation = 1) => ({ version: 1 as const, sessionId: "session", generation, sequence, source: { id: "pi-subagent" }, active: [{ id: "opaque", agent: "worker", status: "running" as const, category: "active" as const, startedAt: 1 }], terminal: { id: "opaque", agent: "worker", status: "completed" as const, completedAt: 2 }, omitted: 0 });

async function withRuntime(run: (runtime: PresenceRuntime, lines: string[]) => Promise<void>, finalClearMs = 20) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-summary-")); const socket = join(dir, "socket"); const lines: string[] = [];
  const server = await fakeSocket(socket, (line) => { lines.push(line); return JSON.stringify({ id: JSON.parse(line).id, result: {} }); });
  const keys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"]; const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(dir, "missing") });
    const runtime = new PresenceRuntime({ getAllTools() { return []; }, events: { emit() {} } } as never, { ...resolvePresenceConfig(), finalClearMs });
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    await run(runtime, lines);
    await runtime.shutdownSession();
  } finally { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await server.close(); await fs.rm(dir, { recursive: true, force: true }); }
}

test("summary metadata clears on terminal timeout and accepted remove", async () => {
  await withRuntime(async (runtime, lines) => {
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    await pause(50);
    runtime.handlePresenceRemove({ version: 1, sessionId: "session", generation: 1, sequence: 2, source: { id: "pi-subagent" } });
    await pause(50);
    const metadata = lines.map((line) => JSON.parse(line)).filter((request) => request.method === "pane.report_metadata").map((request) => request.params.tokens);
    expect(metadata.some((tokens) => tokens.subagents === "1" && tokens.subagent_terminal === "completed")).toBe(true);
    expect(metadata.at(-1)).toMatchObject({ subagents: null, subagent_terminal: null });
  });
});

test("remove tombstones reject stale summary replay and allow a newer companion", async () => {
  await withRuntime(async (runtime, lines) => {
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    await pause(20);
    runtime.handlePresenceRemove({ version: 1, sessionId: "session", generation: 1, sequence: 2, source: { id: "pi-subagent" } });
    await pause(20);
    const afterRemove = lines.length;
    runtime.handleSubagentSummary(summary(1));
    await pause(20);
    expect(lines).toHaveLength(afterRemove);
    runtime.handlePresenceUpdate(update(3));
    runtime.handleSubagentSummary(summary(3));
    await pause(20);
    const metadata = lines.map((line) => JSON.parse(line)).filter((request) => request.method === "pane.report_metadata").map((request) => request.params.tokens);
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
  await withRuntime(async (runtime, lines) => {
    runtime.handlePresenceUpdate(update(1));
    runtime.handleSubagentSummary(summary(1));
    runtime.handleSubagentSummary(summary(1)); // Same-sequence replay is rejected.
    await pause(10);
    runtime.handlePresenceUpdate(update(2));
    runtime.handleSubagentSummary(summary(2)); // Same terminal identity must not extend its first deadline.
    await pause(25);
    const metadata = lines.map((line) => JSON.parse(line)).filter((request) => request.method === "pane.report_metadata").map((request) => request.params.tokens);
    expect(metadata.at(-1)).toMatchObject({ subagents: "1", subagent_terminal: null, subagent_terminal_at: null });
  });
});
