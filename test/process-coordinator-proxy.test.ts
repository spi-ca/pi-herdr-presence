import { expect, test } from "bun:test";

async function runIsolatedCoordinatorProbe(script: string): Promise<{ exitCode: number; stderr: string }> {
  const child = Bun.spawn([process.execPath, "-e", script], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { exitCode, stderr };
}

const installFailure = `
  const slot = Symbol.for("pi-herdr-presence/process-coordinator/v1");
  async function mustReject(trapCalled, getterCalled) {
    try { await import("./src/process-coordinator.ts?isolated-proxy-test"); }
    catch (error) {
      if (trapCalled() || getterCalled()) throw new Error("proxy trap or getter was invoked");
      if (!String(error).includes("Invalid pi-herdr-presence process coordinator.")) throw error;
      return;
    }
    throw new Error("invalid coordinator was accepted");
  }
`;

test("rejects an existing coordinator proxy without invoking traps", async () => {
  const result = await runIsolatedCoordinatorProbe(`${installFailure}
    let trapCalled = false;
    Object.defineProperty(globalThis, slot, {
      value: new Proxy(Object.create(null), {
        getPrototypeOf() { trapCalled = true; throw new Error("global coordinator proxy trap"); },
        getOwnPropertyDescriptor() { trapCalled = true; throw new Error("global coordinator proxy trap"); },
        ownKeys() { trapCalled = true; throw new Error("global coordinator proxy trap"); },
      }),
      configurable: false, enumerable: false, writable: false,
    });
    await mustReject(() => trapCalled, () => false);
  `);
  expect(result).toEqual({ exitCode: 0, stderr: "" });
});

test("rejects a coordinator method proxy without invoking getters or traps", async () => {
  const result = await runIsolatedCoordinatorProbe(`${installFailure}
    let getterCalled = false;
    let trapCalled = false;
    const proxiedMethod = new Proxy(() => undefined, {
      get() { trapCalled = true; throw new Error("method proxy trap"); },
      getOwnPropertyDescriptor() { trapCalled = true; throw new Error("method proxy trap"); },
    });
    const coordinator = Object.create(null);
    const data = (value) => ({ value, configurable: false, enumerable: false, writable: false });
    Object.defineProperties(coordinator, {
      abi: data("pi-herdr-presence/process-coordinator/v1"),
      enqueueAuthority: data(proxiedMethod),
      claimAuthority: { configurable: false, enumerable: false, get() { getterCalled = true; return () => 0; } },
      isAuthority: data(() => false),
      releaseAuthority: data(() => {}),
      acquireOfficialProbe: data(() => null),
      releaseOfficialProbe: data(() => {}),
      acquireSocketFingerprint: data(() => null),
      releaseSocketFingerprint: data(() => {}),
      nextSequence: data(() => 0),
    });
    Object.freeze(coordinator);
    Object.defineProperty(globalThis, slot, { value: coordinator, configurable: false, enumerable: false, writable: false });
    await mustReject(() => trapCalled, () => getterCalled);
  `);
  expect(result).toEqual({ exitCode: 0, stderr: "" });
});
