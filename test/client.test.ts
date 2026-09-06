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

function client(transport: object, timeoutMs = 100, mode: "standalone" | "companion" = "standalone", maxQueue?: number) {
  return new PresenceClient(
    { paneId: "pane", workspaceId: "workspace", socketPath: "/socket" },
    transport as never,
    { ...resolvePresenceConfig(), timeoutMs, ...(maxQueue === undefined ? {} : { maxQueue }) },
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
  await presence.notify("Pi needs attention", "A Pi task needs attention", { actionable: true, sound: "request" });

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
      void presence.notify("Pi needs attention", "A Pi task needs attention", { actionable: true, sound: "request" });
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

test("absolute lifecycle deadlines are checked before transport and passed through unchanged", async () => {
  const deadlines: Array<number | undefined> = [];
  const presence = client({
    async request(line: string, _key?: string, _priority?: boolean, _timeoutMs?: number, _preempt?: readonly string[], deadlineAt?: number) {
      deadlines.push(deadlineAt);
      const request = JSON.parse(line) as Request;
      return JSON.stringify({ id: request.id, result: {} });
    },
    cancel() {}, async close() {},
  });
  const deadlineAt = Date.now() + 1_000;
  await presence.report("idle", session, undefined, deadlineAt);
  await presence.report("working", session, undefined, Date.now() - 1);

  expect(deadlines).toEqual([deadlineAt]);
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

test("teardown prioritizes authority clear after a lost session response", async () => {
  const requests: Request[] = [];
  const priorities: boolean[] = [];
  let sessionRequestSeen!: () => void;
  const sessionRequest = new Promise<void>((resolve) => { sessionRequestSeen = resolve; });
  const presence = client({
    request(line: string, _key?: string, priority = false) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      priorities.push(priority);
      if (request.method === "pane.report_agent_session") {
        sessionRequestSeen();
        return new Promise<string>(() => {});
      }
      return Promise.resolve(JSON.stringify({ id: request.id, result: {} }));
    },
    cancel() {}, async close() {},
  });

  void presence.reportSession(session);
  await sessionRequest;
  await presence.teardown();

  const clearIndex = requests.findIndex(request => request.method === "pane.clear_agent_authority");
  const metadataIndex = requests.findIndex(request => request.method === "pane.report_metadata");
  expect(clearIndex).toBe(1);
  expect(metadataIndex).toBeGreaterThan(clearIndex);
  expect(priorities[clearIndex]).toBe(true);
  expectExactAgentAuthorityClear(requests[clearIndex]!.params);
});

test("teardown prioritizes authority clear after malformed session responses", async () => {
  const requests: Request[] = [];
  const priorities: boolean[] = [];
  const presence = client({
    async request(line: string, _key?: string, priority = false) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      priorities.push(priority);
      return request.method === "pane.report_agent_session"
        ? "malformed response"
        : JSON.stringify({ id: request.id, result: {} });
    },
    cancel() {}, async close() {},
  });

  await presence.reportSession(session);
  await presence.teardown();

  const clearIndex = requests.findIndex(request => request.method === "pane.clear_agent_authority");
  const metadataIndex = requests.findIndex(request => request.method === "pane.report_metadata");
  expect(requests.filter(request => request.method === "pane.report_agent_session")).toHaveLength(2);
  expect(clearIndex).toBe(2);
  expect(metadataIndex).toBeGreaterThan(clearIndex);
  expect(priorities[clearIndex]).toBe(true);
  expectExactAgentAuthorityClear(requests[clearIndex]!.params);
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


test("ordinary reports and metadata cache only acknowledged wire-equivalent projections", async () => {
  const fake = recordingTransport();
  const presence = client(fake.transport);

  await presence.report("working", session, "Pi is working");
  await presence.report("working", session, "Pi is working");
  await presence.metadata(presentation(), idleTokens);
  await presence.metadata(presentation(), { ...idleTokens, summary: "working" });
  await presence.metadata(presentation(), { ...idleTokens, summary: "working" });

  expect(fake.requests.filter(request => request.method === "pane.report_agent")).toHaveLength(1);
  // Startup cleanup remains live; the two distinct metadata projections do not.
  expect(fake.requests.filter(request => request.method === "pane.report_metadata")).toHaveLength(4);
  const sequences = fake.requests.map(request => request.params.seq as number);
  expect(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]!)).toBe(true);
});

test("acknowledged ordinary projections refresh after the fixed freshness TTL", async () => {
  const fake = recordingTransport();
  let now = 10_000;
  const presence = new PresenceClient(
    { paneId: "pane", workspaceId: "workspace", socketPath: "/socket" },
    fake.transport as never,
    resolvePresenceConfig(),
    "standalone",
    () => now,
  );

  await presence.report("idle", session);
  now += 4_999;
  await presence.report("idle", session);
  now += 1;
  await presence.report("idle", session);

  expect(fake.requests.filter(request => request.method === "pane.report_agent")).toHaveLength(2);
});

test("identical ordinary calls share in-flight work and failed semantics remain retryable", async () => {
  const requests: Request[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const presence = client({
    async request(line: string) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      if (request.method !== "pane.report_agent") return JSON.stringify({ id: request.id, result: {} });
      calls += 1;
      if (calls === 1) { await gate; return "invalid"; }
      if (calls === 2) return "invalid";
      return JSON.stringify({ id: request.id, result: {} });
    },
    cancel() {}, async close() {},
  });

  const first = presence.report("working", session);
  const duplicate = presence.report("working", session);
  release();
  await Promise.all([first, duplicate]);
  // The first call exhausted its two attempts; it did not poison the cache.
  await presence.report("working", session);
  await presence.report("working", session);

  expect(requests.filter(request => request.method === "pane.report_agent")).toHaveLength(3);
  const seq = requests.filter(request => request.method === "pane.report_agent").map(request => request.params.seq);
  expect(seq[0]).toBe(seq[1]);
  expect(seq[2]).toBeGreaterThan(seq[1] as number);
});

test("agent and metadata semantic caches are independent", async () => {
  const fake = recordingTransport();
  const presence = client(fake.transport);
  await presence.report("idle", session);
  await presence.metadata(presentation(), idleTokens);
  await presence.report("idle", session);
  await presence.metadata(presentation(), idleTokens);

  expect(fake.requests.filter(request => request.method === "pane.report_agent")).toHaveLength(1);
  expect(fake.requests.filter(request => request.method === "pane.report_metadata")).toHaveLength(3);
});

test("notification response failures are contained without retrying or unhandled rejections", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    for (const response of [
      () => "malformed response",
      () => JSON.stringify({ id: "wrong", result: {} }),
      (request: Request) => JSON.stringify({ id: request.id, error: { code: "denied", message: "notification rejected" } }),
    ]) {
      const requests: Request[] = [];
      const presence = client({
        async request(line: string, _key?: string, _priority?: boolean, _timeout?: number, _preempt?: readonly string[], _deadline?: number, _lane?: string, onAdmission?: (admitted: boolean) => void) {
          const request = JSON.parse(line) as Request;
          requests.push(request);
          onAdmission?.(true);
          return response(request);
        },
        cancel(_key: string) {},
        async close() {},
      });

      expect(presence.notify("Pi needs attention", "A Pi task needs attention", { actionable: true, sound: "request" })).toBe(true);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "notification.show" });
    }
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("fencing synchronously cancels outstanding notification keys", async () => {
  const cancelled: string[] = [];
  let settle!: () => void;
  const pending = new Promise<string>((resolve) => { settle = () => resolve('{"id":"herdr:pi:1","result":{}}'); });
  const presence = client({
    request(_line: string, _key?: string, _priority?: boolean, _timeout?: number, _preempt?: readonly string[], _deadline?: number, _lane?: string, onAdmission?: (admitted: boolean) => void) {
      onAdmission?.(true);
      return pending;
    },
    cancel(key: string) { cancelled.push(key); },
    async close() {},
  });

  expect(presence.notify("Pi needs your input", "Pi needs your input", { actionable: true, sound: "request" }, "input:1")).toBe(true);
  presence.fenceOrdinaryOutput();
  expect(cancelled).toContain("notification:input:1");
  settle();
  await Promise.resolve();
  await Promise.resolve();
  expect((presence as unknown as { outstandingNotificationKeys: Map<string, number> }).outstandingNotificationKeys.size).toBe(0);
});

test("actionable queue residency clamp honors one- and thirty-second boundaries", () => {
  const deadlines: number[] = [];
  const transport = {
    request(_line: string, _key?: string, _priority?: boolean, _timeout?: number, _preempt?: readonly string[], _deadline?: number, _lane?: string, _admission?: unknown, _disposition?: unknown, deadline?: number) {
      if (deadline !== undefined) deadlines.push(deadline - Date.now());
      return Promise.resolve('{"id":"ignored","result":{}}');
    },
    cancel(_key: string) {},
    async close() {},
  };
  client(transport, 1).notify("Pi needs attention", "A Pi task needs attention", { actionable: true, sound: "request" });
  client(transport, 5_000, "standalone", 16).notify("Pi needs attention", "A Pi task needs attention", { actionable: true, sound: "request" });
  expect(deadlines[0]).toBeGreaterThanOrEqual(999);
  expect(deadlines[0]).toBeLessThanOrEqual(1_001);
  expect(deadlines[1]).toBeGreaterThanOrEqual(29_999);
  expect(deadlines[1]).toBeLessThanOrEqual(30_001);
});

test("client separates notification queue lanes from sounds", async () => {
  const requests: Request[] = [];
  const lanes: string[] = [];
  const residencyDeadlines: Array<number | undefined> = [];
  const transport = {
    async request(line: string, _key?: string, _priority?: boolean, _timeoutMs?: number, _preempt?: readonly string[], _deadlineAt?: number, lane?: string, _admission?: (admitted: boolean) => void, _disposition?: unknown, residencyDeadline?: number) {
      const request = JSON.parse(line) as Request;
      requests.push(request);
      lanes.push(lane ?? "missing");
      residencyDeadlines.push(residencyDeadline);
      return JSON.stringify({ id: request.id, result: {} });
    },
    cancel(_key: string) {},
    async close() {},
  };
  const presence = client(transport);
  await presence.notify("Pi needs attention", "A Pi task needs attention", { actionable: true, sound: "request" });
  await presence.notify("Pi activity completed", "Pi activity completed", { actionable: false, sound: "done" });
  await presence.notify("Pi is still working", "A Pi task is taking longer than expected", { actionable: false, sound: "none" });

  expect(requests).toHaveLength(3);
  expect(requests[0]).toMatchObject({ method: "notification.show", params: { title: "Pi needs attention", body: "A Pi task needs attention", sound: "request" } });
  expect(requests[1]).toMatchObject({ method: "notification.show", params: { title: "Pi activity completed", body: "Pi activity completed", sound: "done" } });
  expect(requests[2]).toMatchObject({ method: "notification.show", params: { title: "Pi is still working", body: "A Pi task is taking longer than expected", sound: "none" } });
  expect(lanes).toEqual(["actionable", "replaceable", "replaceable"]);
  // timeout=100 and maxQueue=16 derive 1700ms, clamped independently of the fresh socket timeout.
  expect(residencyDeadlines[0]).toBeGreaterThanOrEqual(Date.now() + 1_600);
  expect(residencyDeadlines.slice(1)).toEqual([undefined, undefined]);
});
