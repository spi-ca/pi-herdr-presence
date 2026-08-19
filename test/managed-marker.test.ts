import { expect, test } from "bun:test";
import { createPresenceProducer } from "@pi/presence";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import extension from "../index.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Listener = (event?: unknown, context?: unknown) => unknown;
type Request = { id: string; method: string; params: Record<string, unknown> };

function eventually(assertion: () => void, timeoutMs = 1_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      try {
        assertion();
        resolve();
      } catch (error) {
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 5);
      }
    };
    attempt();
  });
}

test("the reviewed managed Herdr marker enables bounded companion presentation reporting", async () => {
  const root = await fs.mkdtemp(join(os.tmpdir(), "herdr-managed-marker-"));
  const agentDirectory = join(root, "agent");
  const socketPath = join(root, "socket");
  const requests: Request[] = [];
  const environment = Object.fromEntries(
    ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_WORKSPACE_ID", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  const hooks = new Map<string, Listener[]>();
  const blockedEvents: Array<{ active: boolean; label?: string }> = [];
  let context: { mode: string; isIdle: () => boolean; sessionManager: { getSessionId: () => string } } | undefined;
  let interaction: ReturnType<typeof createPresenceProducer>;
  const eventListeners = new Map<string, Array<(payload: unknown) => void>>();
  const pi = {
    getAllTools() { return []; },
    on(name: string, listener: Listener) {
      const current = hooks.get(name) ?? [];
      current.push(listener);
      hooks.set(name, current);
    },
    events: {
      on(name: string, listener: (payload: unknown) => void) {
        const current = eventListeners.get(name) ?? [];
        current.push(listener);
        eventListeners.set(name, current);
        return () => {};
      },
      emit(name: string, payload: unknown) {
        if (name === "herdr:blocked") blockedEvents.push(payload as { active: boolean; label?: string });
        for (const listener of [...(eventListeners.get(name) ?? [])]) listener(payload);
      },
    },
  };
  const server = await fakeSocket(socketPath, (line) => {
    const request = JSON.parse(line) as Request;
    requests.push(request);
    return JSON.stringify({ id: request.id, result: {} });
  });

  try {
    await fs.mkdir(join(agentDirectory, "extensions"), { recursive: true });
    // Committed review fixture copied from upstream Herdr v8. Real sibling-Herdr
    // compatibility remains the explicit manual smoke check.
    const assetUrl = new URL("./fixtures/herdr-agent-state-v8.ts", import.meta.url);
    const installedAsset = join(agentDirectory, "extensions", "herdr-agent-state.ts");
    await fs.copyFile(assetUrl, installedAsset);
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace",
      PI_CODING_AGENT_DIR: agentDirectory,
    });

    const { default: installManaged } = await import(`${pathToFileURL(installedAsset).href}?managed=${Date.now()}`);
    installManaged(pi as never);
    extension(pi as never);
    expect(hooks.get("session_start")).toHaveLength(2);
    expect(eventListeners.get("herdr:blocked")).toHaveLength(1);

    interaction = createPresenceProducer({ source: "interaction", emit: pi.events.emit })!;
    expect(interaction.activate()).toBe(true);
    // Retained V2 state must acquire the managed integration's counter during replay.
    expect(interaction.publishState({ version: 2, generation: 1, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } })).toBe(true);
    context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "session" } };
    for (const listener of hooks.get("session_start") ?? []) await listener({ reason: "startup" }, context);
    await eventually(() => expect(blockedEvents).toEqual([{ active: true, label: "Pi needs your input" }]));
    await eventually(() => expect(requests.some((request) => request.method === "pane.report_agent" && request.params.source === "herdr:pi" && request.params.state === "blocked" && request.params.message === "Pi needs your input")).toBe(true));
    await eventually(() => expect(requests.some((request) => request.method === "pane.report_metadata" && request.params.source === "herdr:pi-presence")).toBe(true));
    const companion = requests.filter((request) => request.params.source === "herdr:pi-presence");
    expect(companion.every((request) => request.method === "pane.report_metadata")).toBe(true);
    expect(companion.every((request) => request.params.applies_to_source === "herdr:pi")).toBe(true);
    expect(companion.every((request) => !("agent" in request.params) && !("agent_session_id" in request.params))).toBe(true);
    expect(companion.some((request) => request.params.title === `Pi · ${(request.params.tokens as Record<string, unknown>).summary}` && request.params.display_agent === "Pi")).toBe(true);
    expect(companion.some((request) => request.params.clear_title === true && request.params.clear_display_agent === true && request.params.clear_state_labels === true)).toBe(true);

    // Aggregate pending updates neither reacquire nor increment the managed counter.
    expect(interaction.publishState({ version: 2, generation: 1, sequence: 2, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 2 }, attention: { reason: "input_required", occurrence: "new" } })).toBe(true);
    expect(blockedEvents).toEqual([{ active: true, label: "Pi needs your input" }]);
    expect(interaction.withdraw({ version: 2, generation: 1, sequence: 3, source: "interaction" })).toBe(true);
    expect(blockedEvents).toEqual([{ active: true, label: "Pi needs your input" }, { active: false }]);

    expect(interaction.publishState({ version: 2, generation: 2, sequence: 1, source: "interaction", state: "waiting", interaction: { kind: "ask_user", pending: 1 }, attention: { reason: "input_required", occurrence: "new" } })).toBe(true);
    const replacement = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "replacement" } };
    context = replacement;
    const replacing = hooks.get("session_start")?.at(-1)?.({ reason: "replacement" }, replacement);
    // Replacement fences the old counter before its asynchronous teardown/probe.
    expect(blockedEvents).toEqual([
      { active: true, label: "Pi needs your input" }, { active: false },
      { active: true, label: "Pi needs your input" }, { active: false },
    ]);
    await replacing;
    await eventually(() => expect(blockedEvents).toHaveLength(5));
    await eventually(() => {
      const managedStates = requests.filter(request => request.method === "pane.report_agent" && request.params.source === "herdr:pi");
      expect(managedStates.at(-1)?.params.state).toBe("blocked");
    });
    const managedStatesBeforeShutdown = requests.filter(request => request.method === "pane.report_agent" && request.params.source === "herdr:pi").length;
    const stopping = hooks.get("session_shutdown")?.at(-1)?.({}, replacement);
    // Shutdown likewise balances the counter synchronously.
    expect(blockedEvents).toEqual([
      { active: true, label: "Pi needs your input" }, { active: false },
      { active: true, label: "Pi needs your input" }, { active: false },
      { active: true, label: "Pi needs your input" }, { active: false },
    ]);
    await stopping;
    await eventually(() => {
      const managedStates = requests.filter(request => request.method === "pane.report_agent" && request.params.source === "herdr:pi");
      expect(managedStates.length).toBeGreaterThan(managedStatesBeforeShutdown);
      expect(managedStates.at(-1)?.params.state).toBe("idle");
    });
    expect(requests.some((request) => ["pane.report_agent", "pane.report_agent_session", "pane.clear_agent_authority"].includes(request.method) && request.params.source === "herdr:pi-presence")).toBe(false);
  } finally {
    interaction?.deactivate();
    if (context) for (const listener of hooks.get("session_shutdown") ?? []) await listener({}, context);
    await new Promise(resolve => setTimeout(resolve, 5));
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
