import { expect, test } from "bun:test";
import { resolvePresenceConfig } from "../src/config.js";
import { processCoordinator } from "../src/process-coordinator.js";
import { PresenceRuntime } from "../src/runtime.js";

const load = <T>(module: string, instance: string): Promise<T> => import(`${module}?cache-bust=${instance}-${Date.now()}-${Math.random()}`) as Promise<T>;

test("cache-busted coordinators retain one strict global lane, generation, and sequence allocator", async () => {
  const first = await load<typeof import("../src/process-coordinator.js")>("../src/process-coordinator.ts", "first");
  const second = await load<typeof import("../src/process-coordinator.js")>("../src/process-coordinator.ts", "second");
  const coordinator = first.processCoordinator;
  expect(second.processCoordinator).toBe(coordinator);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, Symbol.for("pi-herdr-presence/process-coordinator/v1"));
  expect(descriptor).toMatchObject({ value: coordinator, configurable: false, enumerable: false, writable: false });

  const dateNow = Date.now;
  let firstSequence!: number;
  let secondSequence!: number;
  try {
    Date.now = () => 1_700_000_000_000;
    firstSequence = coordinator.nextSequence()!;
    Date.now = () => 1_600_000_000_000;
    secondSequence = second.processCoordinator.nextSequence()!;
    expect(secondSequence).toBeGreaterThan(firstSequence);
    Date.now = () => Number.POSITIVE_INFINITY;
    expect(coordinator.nextSequence()).toBeUndefined();
    Date.now = () => 1_600_000_000_000;
    expect(coordinator.nextSequence()).toBe(secondSequence + 1);
  } finally {
    Date.now = dateNow;
  }

  const events: string[] = [];
  const oldGeneration = coordinator.claimAuthority();
  let releaseOld!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldTeardown = coordinator.enqueueAuthority(async () => {
    events.push("old-cleanup-start");
    await cleanupGate;
    if (coordinator.isAuthority(oldGeneration)) {
      events.push("old-cleanup-finished");
      coordinator.releaseAuthority(oldGeneration);
    }
  });
  const newStartup = second.processCoordinator.enqueueAuthority(async () => {
    events.push("new-startup");
    expect(coordinator.isAuthority(oldGeneration)).toBe(false);
    return coordinator.claimAuthority();
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(events).toEqual(["old-cleanup-start"]);
  releaseOld();
  const newGeneration = await newStartup;
  await oldTeardown;
  expect(events).toEqual(["old-cleanup-start", "old-cleanup-finished", "new-startup"]);

  await coordinator.enqueueAuthority(async () => {
    // A delayed old-runtime shutdown must not clear a newer authority.
    if (coordinator.isAuthority(oldGeneration)) coordinator.releaseAuthority(oldGeneration);
    else events.push("stale-cleanup-skipped");
  });
  expect(events.at(-1)).toBe("stale-cleanup-skipped");
  expect(coordinator.isAuthority(newGeneration)).toBe(true);
  coordinator.releaseAuthority(newGeneration);
});

test("a stale runtime teardown closes locally without clearing a newer generation", async () => {
  const oldGeneration = processCoordinator.claimAuthority();
  const calls: string[] = [];
  const runtime = new PresenceRuntime({ getAllTools() { return []; }, events: { emit() {} } } as never, resolvePresenceConfig());
  const internal = runtime as unknown as {
    authorityGeneration: number | null;
    client: { teardown(timeoutMs: number): Promise<void>; close(timeoutMs: number): Promise<void> } | null;
    teardown(): Promise<void>;
  };
  internal.authorityGeneration = oldGeneration;
  internal.client = {
    async teardown() { calls.push("remote-clear"); },
    async close() { calls.push("local-close"); },
  };
  const newGeneration = processCoordinator.claimAuthority();
  try {
    await internal.teardown();
    expect(calls).toEqual(["local-close"]);
    expect(processCoordinator.isAuthority(newGeneration)).toBe(true);
  } finally {
    processCoordinator.releaseAuthority(newGeneration);
  }
});

test("cache-busted official-hook modules share one unresolved probe lease", async () => {
  const first = await load<typeof import("../src/official-hook.js")>("../src/official-hook.ts", "first");
  const second = await load<typeof import("../src/official-hook.js")>("../src/official-hook.ts", "second");
  let release!: () => void;
  let calls = 0;
  const stalled = new Promise<"absent">((resolve) => { release = () => resolve("absent"); });
  const inspect = async () => { calls += 1; return stalled; };
  const env = { PI_CODING_AGENT_DIR: "/tmp/herdr-cache-busted-probe" };
  expect(await first.officialHookStatus(env, inspect)).toBe("unknown");
  expect(await second.officialHookStatus(env, inspect)).toBe("unknown");
  expect(calls).toBe(1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
}, 1_000);

test("cache-busted transports share one unresolved fingerprint lease", async () => {
  const first = await load<typeof import("../src/transport.js")>("../src/transport.ts", "first");
  const second = await load<typeof import("../src/transport.js")>("../src/transport.ts", "second");
  let release!: () => void;
  let firstCalls = 0;
  let secondCalls = 0;
  const stalled = new Promise<import("../src/identity.js").SocketFingerprint>((resolve) => { release = () => resolve({ dev: 1, ino: 1, uid: 1 }); });
  const oldTransport = new first.HerdrSocketTransport("/tmp/herdr-cache-busted-first", 5, 1, () => { firstCalls += 1; return stalled; });
  const newTransport = new second.HerdrSocketTransport("/tmp/herdr-cache-busted-second", 5, 1, async () => { secondCalls += 1; return { dev: 1, ino: 1, uid: 1 }; });
  try {
    await expect(oldTransport.request("x\n")).rejects.toThrow("timed out");
    await expect(newTransport.request("x\n")).rejects.toThrow("already unresolved");
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
  } finally {
    release();
    await oldTransport.close(0);
    await newTransport.close(0);
  }
});
