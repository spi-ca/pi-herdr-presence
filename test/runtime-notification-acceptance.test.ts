import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { EVENT_NAMES, createPresenceProducer } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { PresenceRuntime } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Request = { id: string; method: string; params: Record<string, unknown> };

async function eventually(assertion: () => void): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { assertion(); return; } catch (error) { failure = error; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw failure;
}

test("live metadata is queued before a best-effort toast behind an active agent report", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-v2-live-order-"));
  const socketPath = join(directory, "socket");
  const requests: Request[] = [];
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const events = {
    on(name: string, listener: (payload: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    emit(name: string, payload: unknown) { for (const listener of listeners.get(name) ?? []) listener(payload); },
  };
  let live = false;
  let releaseReport!: () => void;
  let reportStarted!: () => void;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  const reportStartedPromise = new Promise<void>(resolve => { reportStarted = resolve; });
  const server = await fakeSocket(socketPath, async line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    if (live && request.method === "pane.report_agent") {
      reportStarted();
      await reportGate;
    }
    return JSON.stringify({ id: request.id, result: {} });
  });
  const runtime = new PresenceRuntime({ getAllTools: () => [], events } as never, { ...resolvePresenceConfig(), soleReporter: true, maxQueue: 1 });
  let producer: ReturnType<typeof createPresenceProducer> | undefined;
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "absent") });
    for (const name of [EVENT_NAMES.state, EVENT_NAMES.terminal, EVENT_NAMES.withdraw]) events.on(name, payload => runtime.handlePresenceEvent(name, payload));
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    requests.length = 0;
    live = true;
    producer = createPresenceProducer({ source: "subagent", emit: events.emit });
    expect(producer?.activate()).toBe(true);
    producer!.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting" });
    producer!.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" });
    await reportStartedPromise;
    // maxQueue=1 keeps metadata behind the active agent report; the terminal
    // toast is intentionally best-effort and therefore loses the saturated race.
    releaseReport();
    await eventually(() => expect(requests.map(request => request.method)).toEqual(["pane.report_agent", "pane.report_metadata"]));
    expect(requests.some(request => request.method === "notification.show")).toBe(false);
  } finally {
    releaseReport?.();
    producer?.deactivate();
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("V2 live terminal failure, blocked attention, and input each deliver one bounded static toast", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-v2-notice-"));
  const socketPath = join(directory, "socket");
  const requests: Request[] = [];
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const events = {
    on(name: string, listener: (payload: unknown) => void) { listeners.set(name, [...(listeners.get(name) ?? []), listener]); },
    emit(name: string, payload: unknown) { for (const listener of listeners.get(name) ?? []) listener(payload); },
  };
  const server = await fakeSocket(socketPath, line => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });
  const runtime = new PresenceRuntime({ getAllTools: () => [], events } as never, { ...{ ...resolvePresenceConfig(), soleReporter: true }, maxQueue: 128 });
  try {
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(directory, "absent") });
    for (const name of [EVENT_NAMES.state, EVENT_NAMES.terminal, EVENT_NAMES.withdraw]) events.on(name, payload => runtime.handlePresenceEvent(name, payload));
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });

    const subagent = createPresenceProducer({ source: "subagent", emit: events.emit })!;
    const interaction = createPresenceProducer({ source: "interaction", emit: events.emit })!;
    expect(subagent.activate()).toBe(true);
    expect(interaction.activate()).toBe(true);
    subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
    await eventually(() => expect(requests.filter(request => request.method === "notification.show")).toHaveLength(1));

    subagent.publishState({ version: 2, generation: 1, sequence: 2, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } });
    await eventually(() => expect(requests.filter(request => request.method === "notification.show")).toHaveLength(2));

    interaction.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } });
    await eventually(() => expect(requests.filter(request => request.method === "notification.show")).toHaveLength(3));
    const notices = requests.filter(request => request.method === "notification.show");
    expect(notices.map(request => request.params)).toEqual([
      { title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" },
      { title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" },
      { title: "Pi needs your input", body: "Pi needs your input", sound: "request" },
    ]);
    expect(JSON.stringify(notices)).not.toContain("private");
    subagent.deactivate();
    interaction.deactivate();
  } finally {
    await runtime.shutdownSession((runtime as unknown as { context: object }).context);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
