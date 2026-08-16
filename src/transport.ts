import net from "node:net";
import { safeSocketFingerprint, type SocketFingerprint } from "./identity.js";

export class PresenceTransportError extends Error {}

function sameFingerprint(left: SocketFingerprint, right: SocketFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.uid === right.uid;
}

async function fingerprint(socketPath: string): Promise<SocketFingerprint> {
  try {
    return await safeSocketFingerprint(socketPath);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : ".";
    throw new PresenceTransportError(`Socket validation failed${detail}`);
  }
}

async function exchange(
  socketPath: string,
  line: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new PresenceTransportError("Socket request aborted.");
  const before = await fingerprint(socketPath);
  if (signal?.aborted) throw new PresenceTransportError("Socket request aborted.");

  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ path: socketPath });
    let buffer = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value ?? "");
    };
    const abort = () => finish(new PresenceTransportError("Socket request aborted."));

    timer = setTimeout(
      () => finish(new PresenceTransportError("Socket request timed out.")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.once("error", (error) => {
      finish(new PresenceTransportError(`Socket failure: ${error.message}`));
    });
    const incompleteResponse = () => {
      finish(new PresenceTransportError("Socket closed before a complete response."));
    };
    socket.once("end", incompleteResponse);
    socket.once("close", incompleteResponse);
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 + 1) {
        finish(new PresenceTransportError("Socket response exceeds its bound."));
        return;
      }

      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const response = buffer.slice(0, end);
      if (buffer.length !== end + 1) {
        finish(new PresenceTransportError("Socket sent more than one response line."));
        return;
      }
      finish(undefined, response);
    });
    socket.once("connect", async () => {
      try {
        const after = await fingerprint(socketPath);
        if (signal?.aborted) {
          abort();
          return;
        }
        if (!sameFingerprint(before, after)) {
          finish(new PresenceTransportError("Socket changed during connection."));
          return;
        }
        socket.write(line, (error) => {
          if (error) finish(new PresenceTransportError(`Socket write failed: ${error.message}`));
        });
      } catch (error) {
        finish(error instanceof Error
          ? error
          : new PresenceTransportError("Socket validation failed."));
      }
    });
  });
}

interface Pending<T> {
  key?: string;
  work: (signal: AbortSignal) => Promise<T>;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/**
 * Serial bounded queue. Pending work with the same key uses latest-write-wins
 * coalescing and shares one promise. Active work is never replaced.
 */
export class BoundedSocketQueue {
  private readonly queue: Array<Pending<unknown>> = [];
  private readonly coalesced = new Map<string, Pending<unknown>>();
  private closed = false;
  private abandon = false;
  private drainPromise: Promise<void> | null = null;
  private active: AbortController | null = null;

  constructor(private readonly maxQueue: number) {}

  enqueue<T>(
    work: ((signal: AbortSignal) => Promise<T>) | (() => Promise<T>),
    key?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new PresenceTransportError("Socket queue is closed."));

    if (key) {
      const existing = this.coalesced.get(key) as Pending<T> | undefined;
      if (existing) {
        existing.work = work as (signal: AbortSignal) => Promise<T>;
        return existing.promise;
      }
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new PresenceTransportError("Socket queue is full."));
    }

    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const pending: Pending<T> = {
      key,
      work: work as (signal: AbortSignal) => Promise<T>,
      promise,
      resolve,
      reject,
    };

    this.queue.push(pending as Pending<unknown>);
    if (key) this.coalesced.set(key, pending as Pending<unknown>);
    this.startDrain();
    return promise;
  }

  async close(timeoutMs: number): Promise<void> {
    this.closed = true;
    const draining = this.drainPromise ?? Promise.resolve();
    if (timeoutMs <= 0) {
      this.abandon = true;
      this.active?.abort();
      this.rejectUndispatched();
      await draining;
      return;
    }

    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    await Promise.race([
      draining,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          this.abandon = true;
          this.active?.abort();
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);

    if (expired) {
      this.rejectUndispatched();
      await (this.drainPromise ?? Promise.resolve());
    } else if (this.queue.length > 0) {
      this.rejectUndispatched();
    }
  }

  private rejectUndispatched(): void {
    const error = new PresenceTransportError("Socket queue closed before dispatch.");
    for (const pending of this.queue.splice(0)) pending.reject(error);
    this.coalesced.clear();
  }

  private startDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0 && !this.closed) this.startDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      if (this.abandon) return;
      const pending = this.queue.shift()!;
      if (pending.key) this.coalesced.delete(pending.key);

      const controller = new AbortController();
      this.active = controller;
      try {
        pending.resolve(await pending.work(controller.signal));
      } catch (error) {
        pending.reject(error);
      } finally {
        if (this.active === controller) this.active = null;
      }
    }
  }
}

export class UnixSocketTransport {
  private readonly queue: BoundedSocketQueue;

  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs: number,
    maxQueue: number,
  ) {
    this.queue = new BoundedSocketQueue(maxQueue);
  }

  request(line: string, key?: string): Promise<string> {
    return this.queue.enqueue(
      (signal) => exchange(this.socketPath, line, this.timeoutMs, signal),
      key,
    );
  }

  async close(timeoutMs = this.timeoutMs): Promise<void> {
    await this.queue.close(timeoutMs);
  }
}
