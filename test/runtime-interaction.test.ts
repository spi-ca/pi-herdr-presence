import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { resolvePresenceConfig } from "../src/config.js";
import { PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms));
const environmentKeys = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"] as const;
type RuntimeConfig = Partial<ReturnType<typeof resolvePresenceConfig>>;

async function withRuntime(config: RuntimeConfig, run: (runtime: PresenceRuntime, lines: string[]) => Promise<void>) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-interaction-"));
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

const interaction = (sequence: number, attention: "none" | "info" = "info") => ({
  version: 1 as const,
  sessionId: "session",
  generation: 1,
  sequence,
  source: { id: "opaque-interaction", label: "secret prompt /private/path", kind: "interaction" },
  state: "waiting" as const,
  counts: { active: 0, completed: 0, failed: 0 },
  attention,
});

const error = (sequence: number) => ({
  version: 1 as const,
  sessionId: "session",
  generation: 1,
  sequence,
  source: { id: "opaque-error", label: "private error", kind: "task" },
  state: "error" as const,
  counts: { active: 0, completed: 0, failed: 1 },
  attention: "error" as const,
});

const remove = (id: string, sequence: number) => ({ version: 1 as const, sessionId: "session", generation: 1, sequence, source: { id } });
const notifications = (lines: string[]) => lines.map((line) => JSON.parse(line)).filter((request) => request.method === "notification.show");
const lastReport = (lines: string[]) => lines.map((line) => JSON.parse(line)).filter((request) => request.method === "pane.report_agent").at(-1);

test("interaction waiting/info is blocked, input-needed, private, and requests notification sound", async () => {
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    await pause();
    const requests = lines.map((line) => JSON.parse(line));
    const report = requests.filter((request) => request.method === "pane.report_agent").at(-1);
    const notification = requests.find((request) => request.method === "notification.show");
    const reportMetadata = requests.filter((request) => request.method === "pane.report_metadata").at(-1);
    expect(report.params).toMatchObject({ state: "blocked", message: "Pi needs your input" });
    expect(reportMetadata.params).toMatchObject({ title: "Pi · Input needed", state_labels: { blocked: "Input needed" } });
    expect(notification.params).toEqual({ title: "Pi needs your input", body: "Pi needs your input", sound: "request" });
    expect(JSON.stringify(requests)).not.toContain("secret prompt");
    expect(JSON.stringify(requests)).not.toContain("/private/path");
  });
});

test("ordinary waiting/info remains working with the generic done notification", async () => {
  await withRuntime({ notificationPolicy: "background" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate({ ...interaction(1), source: { id: "ordinary", label: "opaque", kind: "task" } });
    await pause();
    const requests = lines.map((line) => JSON.parse(line));
    const report = requests.filter((request) => request.method === "pane.report_agent").at(-1);
    const notification = requests.find((request) => request.method === "notification.show");
    expect(report.params).toMatchObject({ state: "working", message: "Pi is working" });
    expect(notification.params).toEqual({ title: "Pi update", body: "Pi activity completed", sound: "done" });
  });
});

test("interaction notifications remain subject to policy, kill switch, and dedupe", async () => {
  await withRuntime({ notificationPolicy: "disabled" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    await pause();
    expect(notifications(lines)).toHaveLength(0);
  });
  await withRuntime({ notifications: false, notificationPolicy: "all" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    await pause();
    expect(notifications(lines)).toHaveLength(0);
  });
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    const event = interaction(1);
    runtime.handlePresenceUpdate(event);
    (runtime as unknown as { render(attention: typeof event): void }).render(event);
    await pause();
    expect(notifications(lines)).toHaveLength(1);
  });
});

test("same-state higher sequences do not re-alert, but exit and re-entry do", async () => {
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    runtime.handlePresenceUpdate(interaction(2));
    await pause();
    expect(notifications(lines)).toHaveLength(1);
    runtime.handlePresenceRemove(remove("opaque-interaction", 3));
    runtime.handlePresenceUpdate(interaction(4));
    await pause();
    expect(notifications(lines)).toHaveLength(2);
  });
});

test("silent replay alerts once on the first live input and rearms only after release", async () => {
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1, "none"));
    await pause();
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs your input" });
    runtime.handlePresenceUpdate(interaction(2));
    runtime.handleBlocked({ active: true, label: "ask-user" });
    await pause();
    expect(notifications(lines)).toHaveLength(1);

    runtime.handleBlocked({ active: false });
    runtime.handlePresenceRemove(remove("opaque-interaction", 3));
    runtime.handlePresenceUpdate(interaction(4));
    await pause();
    expect(notifications(lines)).toHaveLength(2);
  });
});

test("error precedence changes wording but does not reset retained input lifecycle", async () => {
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    await pause();
    runtime.handlePresenceUpdate(error(1));
    await pause();
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs attention" });
    expect(notifications(lines)).toHaveLength(2);
    runtime.handlePresenceRemove(remove("opaque-error", 2));
    await pause();
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs your input" });
    expect(notifications(lines)).toHaveLength(2);
  });
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(error(1));
    await pause();
    runtime.handlePresenceUpdate(interaction(1));
    runtime.handlePresenceUpdate(interaction(2, "none"));
    await pause();
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs attention" });
    expect(notifications(lines)).toHaveLength(1);
    runtime.handlePresenceRemove(remove("opaque-error", 2));
    await pause();
    expect(notifications(lines)).toHaveLength(2);
  });
});

test("native general-block precedence does not reset a retained input lifecycle", async () => {
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    await pause();
    runtime.handleBlocked({ active: true, label: "other native block" });
    await pause();
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs attention" });
    expect(notifications(lines)).toHaveLength(2);
    runtime.handleBlocked({ active: false });
    await pause();
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs your input" });
    expect(notifications(lines)).toHaveLength(2);

    runtime.handlePresenceRemove(remove("opaque-interaction", 2));
    runtime.handlePresenceUpdate(interaction(3));
    await pause();
    expect(notifications(lines)).toHaveLength(3);
  });
});

test("sticky native categories and errors take precedence over input wording", async () => {
  await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
    runtime.handlePresenceUpdate(interaction(1));
    runtime.handleBlocked({ active: true, label: "ask-user" });
    runtime.handleBlocked({ active: true, label: "secret general label" });
    runtime.handleBlocked({ active: false });
    await pause();
    let requests = lines.map((line) => JSON.parse(line));
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs attention" });
    expect(requests.filter((request) => request.method === "pane.report_metadata").at(-1).params).toMatchObject({ title: "Pi · Needs attention", state_labels: { blocked: "Needs attention" } });

    runtime.handleBlocked({ active: false });
    runtime.handlePresenceUpdate(error(2));
    await pause();
    requests = lines.map((line) => JSON.parse(line));
    expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs attention" });
    expect(JSON.stringify(requests)).not.toContain("secret general label");
    expect(JSON.stringify(requests)).not.toContain("private error");
  });
});

test("generic and native ask-user signals dedupe in either arrival and release order", async () => {
  for (const genericFirst of [true, false]) {
    await withRuntime({ notificationPolicy: "errors" }, async (runtime, lines) => {
      if (genericFirst) {
        runtime.handlePresenceUpdate(interaction(1));
        runtime.handleBlocked({ active: true, label: "ask-user" });
      } else {
        runtime.handleBlocked({ active: true, label: "ask-user" });
        runtime.handlePresenceUpdate(interaction(1));
      }
      await pause();
      expect(notifications(lines)).toHaveLength(1);
      expect(notifications(lines)[0].params).toEqual({ title: "Pi needs your input", body: "Pi needs your input", sound: "request" });

      if (genericFirst) runtime.handlePresenceRemove(remove("opaque-interaction", 2));
      else runtime.handleBlocked({ active: false });
      await pause();
      expect(lastReport(lines).params).toMatchObject({ state: "blocked", message: "Pi needs your input" });

      if (genericFirst) runtime.handleBlocked({ active: false });
      else runtime.handlePresenceRemove(remove("opaque-interaction", 2));
      await pause();
      expect(lastReport(lines).params.state).toBe("idle");

      runtime.handlePresenceUpdate(interaction(3));
      await pause();
      expect(notifications(lines)).toHaveLength(2);
    });
  }
});
