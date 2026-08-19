import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
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
    ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]),
  );
  const hooks = new Map<string, Listener[]>();
  let context: { mode: string; isIdle: () => boolean; sessionManager: { getSessionId: () => string } } | undefined;
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
    await fs.copyFile(assetUrl, join(agentDirectory, "extensions", "herdr-agent-state.ts"));
    Object.assign(process.env, {
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: socketPath,
      HERDR_PANE_ID: "pane",
      PI_CODING_AGENT_DIR: agentDirectory,
    });

    const { default: installManaged } = await import(`${assetUrl.href}?managed=${Date.now()}`);
    installManaged(pi as never);
    extension(pi as never);
    expect(hooks.get("session_start")).toHaveLength(2);
    expect(eventListeners.get("herdr:blocked")).toHaveLength(1);

    context = { mode: "tui", isIdle: () => true, sessionManager: { getSessionId: () => "session" } };
    for (const listener of hooks.get("session_start") ?? []) await listener({ reason: "startup" }, context);
    await eventually(() => expect(requests.some((request) => request.method === "pane.report_metadata" && request.params.source === "herdr:pi-presence")).toBe(true));
    const companion = requests.filter((request) => request.params.source === "herdr:pi-presence");
    expect(companion.every((request) => request.method === "pane.report_metadata")).toBe(true);
    expect(companion.every((request) => request.params.applies_to_source === "herdr:pi")).toBe(true);
    expect(companion.every((request) => !("agent" in request.params) && !("agent_session_id" in request.params))).toBe(true);
    expect(companion.some((request) => request.params.title === `Pi · ${(request.params.tokens as Record<string, unknown>).summary}` && request.params.display_agent === "Pi")).toBe(true);
    expect(companion.some((request) => request.params.clear_title === true && request.params.clear_display_agent === true && request.params.clear_state_labels === true)).toBe(true);
    expect(requests.some((request) => ["pane.report_agent", "pane.report_agent_session", "pane.clear_agent_authority"].includes(request.method) && request.params.source === "herdr:pi-presence")).toBe(false);
  } finally {
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
