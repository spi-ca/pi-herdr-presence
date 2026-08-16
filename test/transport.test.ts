import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { fakeSocket, type FakeSocketResponse } from "./helpers/fake-socket.js";
import { BoundedSocketQueue, UnixSocketTransport } from "../src/transport.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()?.(); });

async function fixture(
  handler: (line: string) => FakeSocketResponse,
) {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "presence-test-"));
  const server = await fakeSocket(join(dir, "socket"), handler);
  cleanup.push(async () => { await server.close(); await fs.rm(dir, { recursive: true, force: true }); });
  return join(dir, "socket");
}

describe("Unix socket transport", () => {
  test("exchanges one bounded LF response", async () => {
    const path = await fixture((line) => line === "request" ? "ok" : "no");
    const transport = new UnixSocketTransport(path, 300, 4);
    await expect(transport.request("request\n")).resolves.toBe("ok");
    await transport.close();
  });
  test("times out when a fake server gives no response", async () => {
    const path = await fixture(() => undefined);
    const transport = new UnixSocketTransport(path, 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("timed out");
    await transport.close();
  });
  test("rejects promptly when a socket ends without a complete response", async () => {
    const path = await fixture(() => ({ end: true }));
    const timeoutMs = 300;
    const transport = new UnixSocketTransport(path, timeoutMs, 4);
    const started = performance.now();
    await expect(transport.request("request\n")).rejects.toThrow("closed before a complete response");
    expect(performance.now() - started).toBeLessThan(timeoutMs / 2);
    await transport.close();
  });
  test("rejects a socket that is no longer owner-only before connecting", async () => {
    const path = await fixture(() => "ok");
    await fs.chmod(path, 0o666);
    const transport = new UnixSocketTransport(path, 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("owner-only");
    await transport.close();
  });
  test("rejects a socket beneath a replaceable ancestor even when its direct parent is private", async () => {
    const outer = await fs.mkdtemp(join(os.tmpdir(), "presence-unsafe-"));
    const inner = join(outer, "private");
    await fs.mkdir(inner, { mode: 0o700 });
    const socketPath = join(inner, "socket");
    const server = await fakeSocket(socketPath, () => "ok");
    cleanup.push(async () => { await server.close(); await fs.rm(outer, { recursive: true, force: true }); });
    await fs.chmod(outer, 0o777);
    const transport = new UnixSocketTransport(socketPath, 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("replaceable");
    await transport.close();
  });
  test("rejects a user-owned lexical symlink ancestor even when its resolved target is private", async () => {
    const outer = await fs.mkdtemp(join(os.tmpdir(), "presence-symlink-"));
    const target = join(outer, "target");
    const link = join(outer, "link");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, link);
    const targetSocket = join(target, "socket");
    const server = await fakeSocket(targetSocket, () => "ok");
    cleanup.push(async () => { await server.close(); await fs.rm(outer, { recursive: true, force: true }); });
    const transport = new UnixSocketTransport(join(link, "socket"), 100, 4);
    await expect(transport.request("request\n")).rejects.toThrow("symlink");
    await transport.close();
  });
  test("coalesces keyed pending work into one shared promise and keeps the newest work", async () => {
    const queue = new BoundedSocketQueue(1);
    let release!: () => void;
    const started: string[] = [];
    const blocker = queue.enqueue(async () => { started.push("blocker"); await new Promise<void>((resolve) => { release = resolve; }); return "blocker"; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const first = queue.enqueue(async () => { started.push("first"); return "first"; }, "status");
    const replacement = queue.enqueue(async () => { started.push("replacement"); return "replacement"; }, "status");
    expect(replacement).toBe(first);
    await expect(queue.enqueue(async () => "overflow")).rejects.toThrow("full");
    release();
    await expect(blocker).resolves.toBe("blocker");
    await expect(first).resolves.toBe("replacement");
    expect(started).toEqual(["blocker", "replacement"]);
    await queue.close(50);
  });
  test("drains a request enqueued immediately after awaiting the previous request", async () => {
    const queue = new BoundedSocketQueue(1);
    await expect(queue.enqueue(async () => "first")).resolves.toBe("first");
    await expect(queue.enqueue(async () => "second")).resolves.toBe("second");
    await queue.close(50);
  });
  test("aborts an active exchange at close deadline and leaves no old request alive", async () => {
    const queue = new BoundedSocketQueue(2);
    let observedAbort = false;
    const active = queue.enqueue((signal) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => { observedAbort = true; reject(new Error("aborted")); }, { once: true })));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const queued = queue.enqueue(async () => "never");
    await queue.close(5);
    expect(observedAbort).toBe(true);
    await expect(active).rejects.toThrow("aborted");
    await expect(queued).rejects.toThrow("closed before dispatch");
  });
  test("drains queued work in FIFO order before close and rejects new work", async () => {
    const queue = new BoundedSocketQueue(3);
    let release!: () => void;
    const order: string[] = [];
    const first = queue.enqueue(async () => { order.push("first"); await new Promise<void>((resolve) => { release = resolve; }); return "first"; });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const second = queue.enqueue(async () => { order.push("second"); return "second"; });
    const closing = queue.close(100);
    release();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    await closing;
    expect(order).toEqual(["first", "second"]);
    await expect(queue.enqueue(async () => "late")).rejects.toThrow("closed");
  });
});
