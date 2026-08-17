import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { resolvePresenceConfig } from "../src/config.js";
import { PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
type RuntimeConfig = Partial<ReturnType<typeof resolvePresenceConfig>>;
const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"] as const;

async function withRuntime(config: RuntimeConfig, run: (runtime: PresenceRuntime, lines: string[]) => Promise<void>) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-actionable-"));
  const socket = join(dir, "socket");
  const lines: string[] = [];
  const server = await fakeSocket(socket, (line) => {
    lines.push(line);
    return JSON.stringify({ id: JSON.parse(line).id, result: {} });
  });
  const saved = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(dir, "missing") });
    const runtime = new PresenceRuntime({ getAllTools() { return []; }, events: { emit() {} } } as never, { ...resolvePresenceConfig(), ...config });
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    await run(runtime, lines);
    await runtime.shutdownSession();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const notices = (lines: string[]) => lines.map((line) => JSON.parse(line)).filter((request) => request.method === "notification.show");
const update = (source: string, sequence: number, attention: "none" | "info" | "success" | "error", state = "running") => ({
  version: 1 as const,
  sessionId: "session",
  generation: 1,
  sequence,
  source: { id: source, label: "private producer text", kind: "task" },
  state: state as "running" | "success" | "error",
  counts: { active: state === "running" ? 1 : 0, completed: state === "success" ? 1 : 0, failed: state === "error" ? 1 : 0 },
  attention,
});

test("default policy keeps start, progress, long-running, and ordinary success quiet", async () => {
  await withRuntime({ longRunningMs: 10 }, async (runtime, lines) => {
    runtime.handleAgentStart();
    runtime.handlePresenceUpdate(update("progress", 1, "success", "success"));
    await pause();
    runtime.handleAgentSettled({ isIdle: () => true });
    await pause();
    expect(notices(lines)).toHaveLength(0);
  });
});

test("default policy alerts only new errors, input lifecycles, and native general blocks", async () => {
  await withRuntime({}, async (runtime, lines) => {
    runtime.handlePresenceUpdate(update("error", 1, "error", "error"));
    await pause();
    runtime.handlePresenceUpdate({ ...update("error", 2, "none"), state: "running" as const });
    runtime.handlePresenceUpdate({ ...update("input", 1, "info"), source: { id: "input", label: "private prompt", kind: "interaction" }, state: "waiting" as const, counts: { active: 0, completed: 0, failed: 0 } });
    await pause();
    runtime.handlePresenceRemove({ version: 1, sessionId: "session", generation: 1, sequence: 2, source: { id: "input" } });
    runtime.handleBlocked({ active: true, label: "private native block" });
    await pause();
    expect(notices(lines).map((request) => request.params.title)).toEqual(["Pi needs attention", "Pi needs your input", "Pi needs attention"]);
  });
});

test("advanced external policy coalesces bursts and rearms only after a semantic transition", async () => {
  await withRuntime({ notificationPolicy: "all" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(update("success", 1, "success", "success"));
    runtime.handlePresenceUpdate(update("success", 2, "success", "success"));
    runtime.handlePresenceUpdate(update("info", 1, "info"));
    runtime.handlePresenceUpdate(update("error", 1, "error", "error"));
    await pause();
    expect(notices(lines)).toHaveLength(1);
    expect(notices(lines)[0].params).toMatchObject({ title: "Pi needs attention", sound: "request" });

    runtime.handlePresenceUpdate(update("error", 2, "error", "error"));
    await pause();
    expect(notices(lines)).toHaveLength(1);
    runtime.handlePresenceUpdate(update("error", 3, "none"));
    runtime.handlePresenceUpdate(update("error", 4, "error", "error"));
    await pause();
    expect(notices(lines)).toHaveLength(2);
  });
});
