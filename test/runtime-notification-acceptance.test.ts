import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { EVENT_NAMES, createPresenceProducer } from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { isExactCompanionMetadataClearParams, isExactCompanionMetadataParams } from "../src/protocol.js";
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
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
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
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "absent") });
    for (const name of [EVENT_NAMES.state, EVENT_NAMES.terminal, EVENT_NAMES.withdraw]) events.on(name, payload => runtime.handlePresenceEvent(name, payload));
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });
    // The final local idle projection is deliberately queued before the
    // observer-only lease, which can defer under this one-slot transport.
    await eventually(() => expect(requests.filter(request => request.method === "pane.report_metadata").length).toBeGreaterThanOrEqual(2));
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

test("companion emits a policy-eligible static notification with exact presentation metadata and no authority calls", async () => {
  const directory = await fs.mkdtemp(join(os.tmpdir(), "herdr-v2-companion-notice-"));
  const agentDirectory = join(directory, "agent");
  const socketPath = join(directory, "socket");
  const requests: Request[] = [];
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
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
  const runtime = new PresenceRuntime({ getAllTools: () => [], events } as never, {
    ...resolvePresenceConfig(), enabled: true, mode: "auto", metadata: true, notifications: true, notificationPolicy: "errors", maxQueue: 128,
  });
  let producer: ReturnType<typeof createPresenceProducer> | undefined;
  try {
    await fs.mkdir(join(agentDirectory, "extensions"), { recursive: true });
    await fs.writeFile(join(agentDirectory, "extensions", "herdr-agent-state.ts"), "HERDR_INTEGRATION_ID=pi");
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: agentDirectory });
    for (const name of [EVENT_NAMES.state, EVENT_NAMES.terminal, EVENT_NAMES.withdraw]) events.on(name, payload => runtime.handlePresenceEvent(name, payload));
    await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "session" } });

    producer = createPresenceProducer({ source: "subagent", emit: events.emit });
    expect(producer?.activate()).toBe(true);
    producer!.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
    await eventually(() => expect(requests.filter(request => request.method === "notification.show")).toHaveLength(1));

    const notices = requests.filter(request => request.method === "notification.show");
    expect(notices.map(request => request.params)).toEqual([{ title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" }]);
    const metadata = requests.filter(request => request.method === "pane.report_metadata");
    expect(metadata).not.toHaveLength(0);
    expect(requests.some(request => request.method === "pane.list" && request.params.workspace_id === "workspace")).toBe(true);
    for (const request of metadata) {
      expect(request.method).toBe("pane.report_metadata");
      expect(isExactCompanionMetadataParams(request.params) || isExactCompanionMetadataClearParams(request.params)).toBe(true);
      expect(request.params).toMatchObject({ source: "herdr:pi-presence", applies_to_source: "herdr:pi" });
      for (const field of ["agent", "agent_session_id", "session_start_source", "state", "message", "focus", "control"]) {
        expect(request.params).not.toHaveProperty(field);
      }
      if (isExactCompanionMetadataParams(request.params)) {
        expect(request.params).toMatchObject({ title: `Pi · ${(request.params.tokens as Record<string, unknown>).summary}`, display_agent: "Pi", state_labels: { idle: "Pi is idle", working: "Pi is working", blocked: "Pi needs attention", unknown: "Pi state unknown" } });
      } else {
        expect(request.params).toMatchObject({ clear_title: true, clear_display_agent: true, clear_state_labels: true });
      }
      expect(Object.keys(request.params.tokens as object)).not.toContain("active");
    }
    expect(requests.some(request => ["pane.report_agent", "pane.report_agent_session", "pane.clear_agent_authority"].includes(request.method))).toBe(false);
  } finally {
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
  const saved = Object.fromEntries(["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"].map(key => [key, process.env[key]]));
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
    Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace", PI_CODING_AGENT_DIR: join(directory, "absent") });
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
