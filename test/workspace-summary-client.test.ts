import { expect, test } from "bun:test";
import { PresenceClient } from "../src/client.js";
import { resolvePresenceConfig } from "../src/config.js";
import { WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS, WORKSPACE_MAIN_SUMMARY_TTL_MS } from "../src/protocol.js";
import { paneInfo } from "./fixtures/pane-info.js";

type Request = { id: string; method: string; params: Record<string, unknown> };

function runWith(result: unknown) {
  const requests: Request[] = [];
  const client = new PresenceClient(
    { paneId: "this-pane", workspaceId: "workspace", socketPath: "/socket" },
    { async request(line: string) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      return JSON.stringify({ id: request.id, result: request.method === "pane.list" ? result : { type: "ok" } });
    }, cancel(_key: string) {}, async close() {} } as never,
    resolvePresenceConfig(),
  );
  return { client, requests };
}

const sole = { type: "pane_list", panes: [paneInfo({ pane_id: "this-pane" })] };

test("workspace summary publishes only for this pane as the sole Pi authority and carries its bounded lease", async () => {
  const { client, requests } = runWith(sole);
  await client.workspaceMainSummary("working · 1/2");
  expect(requests.map(request => request.method)).toEqual(["pane.list", "workspace.report_metadata"]);
  expect(requests[0]!.params).toEqual({ workspace_id: "workspace" });
  expect(requests[1]!.params).toEqual({
    workspace_id: "workspace", source: "herdr:pi-presence", seq: expect.any(Number),
    ttl_ms: WORKSPACE_MAIN_SUMMARY_TTL_MS, tokens: { main_summary: "working · 1/2" },
  });
});

test("workspace summary ignores nullable, absent, and non-Pi PaneInfo agents while retaining the sole Pi", async () => {
  const { client, requests } = runWith({
    type: "pane_list",
    panes: [
      ...sole.panes,
      paneInfo({ pane_id: "shell", agent: "shell" }),
      (() => { const { agent: _agent, ...unmanaged } = paneInfo({ pane_id: "unmanaged" }); return unmanaged; })(),
      paneInfo({ pane_id: "unknown", agent: null }),
    ],
  });
  await client.workspaceMainSummary("idle");
  expect(requests.map(request => request.method)).toEqual(["pane.list", "workspace.report_metadata"]);
});

test("workspace summary fails closed for multi, missing, foreign, and malformed Pi eligibility", async () => {
  const cases: unknown[] = [
    { type: "pane_list", panes: [...sole.panes, paneInfo({ pane_id: "other" })] },
    { type: "pane_list", panes: [] },
    { type: "pane_list", panes: [paneInfo({ pane_id: "other" })] },
    { type: "pane_list", panes: [{ ...paneInfo({ pane_id: "this-pane" }), agent: 1 }] },
    { type: "pane_list", panes: [{ ...paneInfo({ pane_id: "this-pane" }), agent: "" }] },
    { type: "wrong", panes: sole.panes },
  ];
  for (const result of cases) {
    const { client, requests } = runWith(result);
    await client.workspaceMainSummary("idle");
    expect(requests.map(request => request.method)).toEqual(["pane.list"]);
  }
});

test("workspace summary drains a summary queued as the active publication settles", async () => {
  const requests: Request[] = [];
  let releaseReport!: () => void;
  let reportStarted!: () => void;
  let late: Promise<void> | undefined;
  const reportGate = new Promise<void>(resolve => { releaseReport = resolve; });
  const reportStartedPromise = new Promise<void>(resolve => { reportStarted = resolve; });
  let client!: PresenceClient;
  const transport = {
    async request(line: string) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.method === "pane.list") return JSON.stringify({ id: request.id, result: sole });
      if (request.method === "workspace.report_metadata" && !late) {
        reportStarted();
        await reportGate;
        queueMicrotask(() => { late = client.workspaceMainSummary("working"); });
      }
      return JSON.stringify({ id: request.id, result: { type: "ok" } });
    },
    async close() {},
  };
  client = new PresenceClient(
    { paneId: "this-pane", workspaceId: "workspace", socketPath: "/socket" },
    transport as never,
    resolvePresenceConfig(),
  );

  const initial = client.workspaceMainSummary("idle");
  await reportStartedPromise;
  releaseReport();
  await initial;
  await late;

  expect(requests.filter(request => request.method === "workspace.report_metadata").map(request => request.params.tokens)).toEqual([
    { main_summary: "idle" }, { main_summary: "working" },
  ]);
});

test("workspace list and write use one fixed budget without retrying when the global timeout is 30 seconds", async () => {
  const calls: Array<{ method: string; timeout: number | undefined }> = [];
  const client = new PresenceClient(
    { paneId: "this-pane", workspaceId: "workspace", socketPath: "/socket" },
    { async request(line: string, _key?: string, _priority?: boolean, timeout?: number) {
      const request = JSON.parse(line) as Request;
      calls.push({ method: request.method, timeout });
      return JSON.stringify({ id: request.id, result: request.method === "pane.list" ? sole : { type: "ok" } });
    }, async close() {} } as never,
    { ...resolvePresenceConfig(), timeoutMs: 30_000 },
  );
  await client.workspaceMainSummary("idle");
  expect(calls).toEqual([
    { method: "pane.list", timeout: WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS },
    { method: "workspace.report_metadata", timeout: WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS },
  ]);
});

test("workspace timeout failures get no retry", async () => {
  const requests: Request[] = [];
  const client = new PresenceClient(
    { paneId: "this-pane", workspaceId: "workspace", socketPath: "/socket" },
    { async request(line: string) {
      requests.push(JSON.parse(line) as Request);
      throw new Error("simulated slow request timeout");
    }, async close() {} } as never,
    { ...resolvePresenceConfig(), timeoutMs: 30_000 },
  );
  await client.workspaceMainSummary("idle");
  expect(requests.map(request => request.method)).toEqual(["pane.list"]);
});

test("workspace eligibility and teardown never issue a destructive workspace clear", async () => {
  const { client, requests } = runWith(sole);
  await client.workspaceMainSummary("idle");
  await client.teardown();
  const workspace = requests.filter(request => request.method === "workspace.report_metadata");
  expect(workspace).toHaveLength(1);
  expect(workspace[0]!.params).not.toHaveProperty("clear_tokens");
  expect(workspace[0]!.params.tokens).toEqual({ main_summary: "idle" });
});
