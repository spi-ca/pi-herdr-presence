import { expect, test } from "bun:test";
import { LEGACY_METADATA_TOKENS, OWNED_METADATA_TOKENS, PresenceClient } from "../src/client.js";
import { resolvePresenceConfig } from "../src/config.js";
import type { HerdrMetadataTokens } from "../src/protocol.js";
import { presentation } from "../src/presentation.js";
import { BoundedSocketQueue } from "../src/transport.js";
import { expectExactAgentAuthorityClear, expectExactCompanionMetadataClear, expectExactCompanionMetadataIngress, expectExactLegacyMetadataClear, expectExactMetadataClear, expectExactMetadataIngress } from "./fixtures/metadata-ingress.js";

type Request = { id: string; method: string; params: Record<string, unknown> };
const session = { agent_session_id: "root-session" } as const;
const nullTokens = Object.fromEntries(OWNED_METADATA_TOKENS.map((key) => [key, null])) as HerdrMetadataTokens;
const idleTokens = { ...nullTokens, summary: "idle" };
const metadata = (tokens: HerdrMetadataTokens = idleTokens) => tokens;

function recordingTransport() {
  const requests: Request[] = [];
  const closes: number[] = [];
  return {
    requests,
    closes,
    transport: {
      async request(line: string) {
        const request = JSON.parse(line) as Request;
        requests.push(request);
        return JSON.stringify({ id: request.id, result: {} });
      },
      cancel(_key: string) {},
      async close(timeoutMs?: number) { closes.push(timeoutMs ?? -1); },
    },
  };
}

function client(transport: object, timeoutMs = 100, mode: "standalone" | "companion" = "standalone") {
  return new PresenceClient(
    { paneId: "pane", workspaceId: "workspace", socketPath: "/socket" },
    transport as never,
    { ...resolvePresenceConfig(), timeoutMs },
    mode,
  );
}

test("report_agent_session and report project an ID-only session reference", async () => {
  const fake = recordingTransport();
  const presence = client(fake.transport);

  await presence.reportSession(session, "session restored");
  await presence.report("working", session, "Pi is working");

  expect(fake.requests).toHaveLength(2);
  for (const request of fake.requests) {
    expect(request.params).toMatchObject({ pane_id: "pane", source: "herdr:pi", agent: "pi", agent_session_id: "root-session" });
    expect(request.params).not.toHaveProperty("agent_session_path");
  }
  expect(fake.requests[0]).toMatchObject({ method: "pane.report_agent_session", params: { session_start_source: "session restored" } });
  expect(fake.requests[1]).toMatchObject({ method: "pane.report_agent", params: { state: "working", message: "Pi is working" } });
});

test("client allocator is process-monotonic across replacement clients and wall-clock regression", async () => {
  const fake = recordingTransport();
  const now = Date.now;
  try {
    Date.now = () => 1_700_000_000_000;
    const first = client(fake.transport);
    await first.report("working", session);
    Date.now = () => 1_600_000_000_000;
    const replacement = client(fake.transport);
    await replacement.report("idle", session);
    await first.metadata(presentation(), idleTokens);
    const sequences = fake.requests.map((request) => request.params.seq as number);
    expect(sequences).toHaveLength(5);
    expect(sequences.every((sequence, index) => index === 0 || sequence > sequences[index - 1]!)).toBe(true);
    expect(sequences[0]).toBeGreaterThanOrEqual(1_700_000_000_000_001);
  } finally {
    Date.now = now;
  }
});

test("startup clears exact current and legacy chunks before ordinary metadata", async () => {
  const fake = recordingTransport();
  const presence = client(fake.transport);
  const populated = {
    summary: "input · 2/5 · running 1 · queued 2 · input 1",
    v2_progress: "2/5",
    v2_attention: "failure:new",
    v2_interaction: "ask_user:1",
    v2_subagents: "1,0,2,3,4,5,6",
    v2_terminals: "subagent:2:4:failed",
    v2_terminal_overflow: "0",
    tokens: "12",
    cost: "0.5",
    context: "20",
  };

  await presence.prepareSessionAuthority();
  await presence.metadata(presentation(), metadata(populated));
  await presence.clearLegacyMetadata();
  await presence.clearMetadata();

  const current = fake.requests[0]!;
  const legacy = fake.requests[1]!;
  const report = fake.requests[2]!;
  const clear = fake.requests[3]!;
  expect(current.method).toBe("pane.report_metadata");
  expectExactMetadataClear(current.params);
  expectExactLegacyMetadataClear(legacy.params);
  expect(Object.keys(legacy.params.tokens as object)).toHaveLength(LEGACY_METADATA_TOKENS.length);
  expectExactMetadataIngress(report.params);
  expectExactMetadataClear(clear.params);
  expect(report.params.tokens).toEqual(populated);
  expect(clear.params.tokens).toEqual(nullTokens);
  // Once presentation has started, startup cleanup cannot enqueue a late clear.
  expect(fake.requests).toHaveLength(4);
});

test("a failed legacy migration is one bounded attempt and does not block normal metadata or notifications", async () => {
  const requests: Request[] = [];
  const presence = client({
    async request(line: string) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      return request.params.tokens && Object.hasOwn(request.params.tokens as object, "active")
        ? "invalid response"
        : JSON.stringify({ id: request.id, result: {} });
    },
    cancel(_key: string) {},
    async close() {},
  });

  await presence.metadata(presentation(), idleTokens);
  await presence.notify("Pi needs attention", "A Pi task needs attention", true);

  expect(requests.map((request) => request.method)).toEqual(["pane.report_metadata", "pane.report_metadata", "pane.report_metadata", "notification.show"]);
  expectExactMetadataClear(requests[0]!.params);
  expectExactLegacyMetadataClear(requests[1]!.params);
  expectExactMetadataIngress(requests[2]!.params);
});

test("startup current metadata clear makes one attempt after timeout or invalid response", async () => {
  for (const failure of ["timeout", "invalid"] as const) {
    const requests: Request[] = [];
    const presence = client({
      async request(line: string) {
        const request = JSON.parse(line) as Request;
        requests.push(request);
        if ("clear_title" in request.params) {
          if (failure === "timeout") throw new Error("Socket request timed out.");
          return "invalid response";
        }
        return JSON.stringify({ id: request.id, result: {} });
      },
      async close() {},
    });

    await presence.prepareSessionAuthority();

    const current = requests.filter((request) => "clear_title" in request.params);
    const legacy = requests.filter((request) => request.params.tokens && Object.hasOwn(request.params.tokens as object, "active"));
    expect(current).toHaveLength(1);
    expectExactMetadataClear(current[0]!.params);
    expect(legacy).toHaveLength(1);
    expectExactLegacyMetadataClear(legacy[0]!.params);
  }
});

test("metadata-disabled clients still clear stale current and legacy ownership at startup and teardown", async () => {
  const fake = recordingTransport();
  const presence = new PresenceClient(
    { paneId: "pane", workspaceId: "workspace", socketPath: "/socket" },
    fake.transport as never,
    { ...resolvePresenceConfig(), metadata: false },
  );

  await presence.prepareSessionAuthority();
  await presence.metadata(presentation(), nullTokens);
  await presence.teardown();

  expect(fake.requests.map((request) => request.method)).toEqual([
    "pane.report_metadata", "pane.report_metadata", "pane.report_metadata", "pane.report_metadata", "pane.clear_agent_authority",
  ]);
  expectExactMetadataClear(fake.requests[0]!.params);
  expectExactLegacyMetadataClear(fake.requests[1]!.params);
  expectExactMetadataClear(fake.requests[2]!.params);
  expectExactLegacyMetadataClear(fake.requests[3]!.params);
  expectExactAgentAuthorityClear(fake.requests[4]!.params);
});

test("companion owns fixed presentation metadata without managed authority calls", async () => {
  const fake = recordingTransport();
  const presence = client(fake.transport, 100, "companion");
  await presence.prepareSessionAuthority();
  await presence.reportSession(session);
  await presence.report("working", session, "Pi is working");
  await presence.metadata(presentation(), idleTokens);
  await presence.teardown();

  expect(fake.requests).toHaveLength(3);
  expectExactCompanionMetadataClear(fake.requests[0]!.params);
  expectExactCompanionMetadataIngress(fake.requests[1]!.params);
  expectExactCompanionMetadataClear(fake.requests[2]!.params);
  for (const request of fake.requests) {
    expect(request.method).toBe("pane.report_metadata");
    expect(request.params).toMatchObject({ source: "herdr:pi-presence", applies_to_source: "herdr:pi" });
    expect(request.params).not.toHaveProperty("agent");
    expect(request.params).not.toHaveProperty("agent_session_id");
  }
  expect(fake.requests.some(request => request.method === "pane.report_agent" || request.method === "pane.report_agent_session" || request.method === "pane.clear_agent_authority")).toBe(false);
});

test("invalid output and serialization failures are contained without dispatch", async () => {
  const fake = recordingTransport();
  const invalid = new PresenceClient(
    { paneId: "😀".repeat(65), workspaceId: "workspace", socketPath: "/socket" },
    fake.transport as never,
    resolvePresenceConfig(),
  );

  await expect(invalid.report("working", session)).resolves.toBeUndefined();
  await expect(invalid.reportSession(session)).resolves.toBeUndefined();
  expect(fake.requests).toHaveLength(0);
  expect((invalid as unknown as { keyRevisions: Map<string, number> }).keyRevisions.size).toBe(0);

  const stringify = JSON.stringify;
  const serializationFailure = client(fake.transport) as unknown as { report(state: "idle", sessionRef: { agent_session_id: string }): Promise<void>; keyRevisions: Map<string, number> };
  try {
    JSON.stringify = () => { throw new Error("serialization failure"); };
    await expect(serializationFailure.report("idle", session)).resolves.toBeUndefined();
  } finally {
    JSON.stringify = stringify;
  }
  expect(fake.requests).toHaveLength(0);
  expect(serializationFailure.keyRevisions.size).toBe(0);
});

test("an invalid session reason is omitted rather than leaking or rejecting the session report", async () => {
  const fake = recordingTransport();
  const presence = client(fake.transport);

  await presence.reportSession(session, "bad\u0000reason");

  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]!.params).toMatchObject({ agent_session_id: "root-session" });
  expect(fake.requests[0]!.params).not.toHaveProperty("session_start_source");
});

test("invalid sequence clocks make fire-and-forget lifecycle output fail closed without unhandled rejections", async () => {
  const now = Date.now;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const invalidNow of [Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER] as const) {
      const fake = recordingTransport();
      Date.now = () => invalidNow;
      const presence = client(fake.transport);
      void presence.reportSession(session);
      void presence.report("working", session);
      void presence.metadata(presentation(), nullTokens);
      void presence.clearLegacyMetadata();
      void presence.clearMetadata();
      void presence.notify("Pi needs attention", "A Pi task needs attention", true);
      void presence.teardown();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(fake.requests.map(request => request.method)).toEqual(["notification.show"]);
    }
    expect(unhandled).toEqual([]);
  } finally {
    Date.now = now;
    process.off("unhandledRejection", onUnhandled);
  }
});

test("lifecycle transport retries split the configured timeout across two attempts", async () => {
  const timeouts: number[] = [];
  const transport = {
    async request(line: string, _key?: string, _priority?: boolean, timeoutMs?: number) {
      const request = JSON.parse(line) as Request;
      timeouts.push(timeoutMs!);
      return timeouts.length === 1 ? "not json" : JSON.stringify({ id: request.id, result: { type: "ok" } });
    },
    cancel(_key: string) {},
    async close() {},
  };

  await client(transport, 701).report("working", session);

  expect(timeouts).toEqual([350, 351]);
});

test("a minimum lifecycle timeout remains one nonzero bounded attempt", async () => {
  const timeouts: number[] = [];
  const transport = {
    async request(line: string, _key?: string, _priority?: boolean, timeoutMs?: number) {
      const request = JSON.parse(line) as Request;
      timeouts.push(timeoutMs!);
      return JSON.stringify({ id: request.id, result: {} });
    },
    cancel(_key: string) {},
    async close() {},
  };

  await client(transport, 1).report("working", session);

  expect(timeouts).toEqual([1]);
});

test("teardown clears authority once after metadata cleanup and closes within its aggregate deadline", async () => {
  const requests: Request[] = [];
  const priorities: boolean[] = [];
  const closes: number[] = [];
  const transport = {
    async request(line: string, _key?: string, priority = false) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      priorities.push(priority);
      return request.method === "pane.clear_agent_authority"
        ? JSON.stringify({ id: request.id, error: { code: "rejected", message: "authority unavailable" } })
        : JSON.stringify({ id: request.id, result: {} });
    },
    cancel(_key: string) {},
    async close(timeoutMs?: number) { closes.push(timeoutMs ?? -1); },
  };

  await client(transport, 100).teardown();

  expect(requests.map((request) => request.method)).toEqual(["pane.report_metadata", "pane.report_metadata", "pane.clear_agent_authority"]);
  expectExactMetadataClear(requests[0]!.params);
  expectExactLegacyMetadataClear(requests[1]!.params);
  expectExactAgentAuthorityClear(requests[2]!.params);
  expect(priorities).toEqual([true, true, true]);
  expect(closes).toHaveLength(1);
  expect(closes[0]).toBeGreaterThanOrEqual(0);
  expect(closes[0]).toBeLessThanOrEqual(100);
});

test("teardown expiry closes promptly and never dispatches authority clear after a stuck metadata clear", async () => {
  const requests: string[] = [];
  const closes: number[] = [];
  const transport = {
    request(line: string) {
      requests.push((JSON.parse(line) as Request).method);
      return new Promise<string>(() => {});
    },
    cancel(_key: string) {},
    async close(timeoutMs?: number) { closes.push(timeoutMs ?? -1); },
  };

  const completed = client(transport, 25).teardown();
  await expect(Promise.race([
    completed.then(() => "closed"),
    new Promise<string>((resolve) => setTimeout(() => resolve("timed out"), 100)),
  ])).resolves.toBe("closed");

  expect(requests).toEqual(["pane.report_metadata"]);
  expect(closes).toEqual([0]);
});

test("teardown fences an active lifecycle failure so no stale retry follows clear", async () => {
  const queue = new BoundedSocketQueue(4);
  const dispatched: string[] = [];
  let releaseActive!: () => void;
  let activeStarted!: () => void;
  const gate = new Promise<void>((resolve) => { releaseActive = resolve; });
  const started = new Promise<void>((resolve) => { activeStarted = resolve; });
  const transport = {
    request(line: string, key?: string, priority = false) {
      const request = JSON.parse(line) as Request;
      return queue.enqueue(async () => {
        dispatched.push(request.method);
        if (request.method === "pane.report_agent") {
          activeStarted();
          await gate;
          throw new Error("active report failed");
        }
        return JSON.stringify({ id: request.id, result: {} });
      }, key, priority);
    },
    cancel(_key: string) {},
    async close(timeoutMs?: number) { await queue.close(timeoutMs); },
  };
  const presence = client(transport);

  const report = presence.report("working", session);
  await started;
  const teardown = presence.teardown();
  releaseActive();
  await Promise.all([report, teardown]);

  expect(dispatched).toEqual(["pane.report_agent", "pane.report_metadata", "pane.report_metadata", "pane.clear_agent_authority"]);
});

test("a failed stale keyed agent attempt cannot retry over the latest state", async () => {
  const queue = new BoundedSocketQueue(4);
  const dispatched: string[] = [];
  let releaseOld!: () => void;
  let releaseSession!: () => void;
  let oldStarted!: () => void;
  let sessionStarted!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  const oldStartedPromise = new Promise<void>((resolve) => { oldStarted = resolve; });
  const sessionStartedPromise = new Promise<void>((resolve) => { sessionStarted = resolve; });
  let latest: Promise<void> | undefined;
  let presence!: PresenceClient;
  const transport = {
    request(line: string, key?: string, priority = false) {
      const request = JSON.parse(line) as Request;
      return queue.enqueue(async () => {
        dispatched.push(`${request.method}:${request.params.state ?? ""}`);
        if (request.method === "pane.report_agent" && request.params.state === "working") {
          oldStarted();
          await oldGate;
          throw new Error("first attempt failed");
        }
        if (request.method === "pane.report_agent_session") {
          latest = presence.report("idle", session);
          sessionStarted();
          await sessionGate;
        }
        return JSON.stringify({ id: request.id, result: {} });
      }, key, priority);
    },
    cancel(key: string) { queue.cancel(key); },
    async close(timeoutMs?: number) { await queue.close(timeoutMs); },
  };
  presence = client(transport);

  const stale = presence.report("working", session);
  await oldStartedPromise;
  const reportSession = presence.reportSession(session);
  releaseOld();
  await sessionStartedPromise;
  await Promise.resolve();
  expect(dispatched.filter((entry) => entry.startsWith("pane.report_agent:"))).toEqual(["pane.report_agent:working"]);

  releaseSession();
  await Promise.all([stale, reportSession, latest!]);
  expect(dispatched.filter((entry) => entry.startsWith("pane.report_agent:"))).toEqual([
    "pane.report_agent:working",
    "pane.report_agent:idle",
  ]);
  await queue.close();
});


test("client sends bounded static notification requests without retrying them", async () => {
  const fake = recordingTransport();
  await client(fake.transport).notify("Pi needs attention", "A Pi task needs attention", true);
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]).toMatchObject({ method: "notification.show", params: { title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" } });
});
