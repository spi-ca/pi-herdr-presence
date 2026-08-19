import net from "node:net";
import { safeSocketFingerprint, type SocketFingerprint } from "./identity.js";
import { processCoordinator } from "./process-coordinator.js";

export class PresenceTransportError extends Error {}

/**
 * One process may have only one unabortable filesystem validation in flight.
 * The global, endpoint-agnostic lease survives cache-busted module and session
 * replacement until abandoned filesystem work settles.
 */
function beginFingerprint(
	endpoint: string,
	fingerprint: (candidate: string) => Promise<SocketFingerprint>,
): Promise<SocketFingerprint> {
	const lease = processCoordinator.acquireSocketFingerprint();
	if (!lease) {
		return Promise.reject(
			new PresenceTransportError("Socket validation is already unresolved."),
		);
	}

	return Promise.resolve()
		.then(() => fingerprint(endpoint))
		.finally(() => processCoordinator.releaseSocketFingerprint(lease));
}

async function exchange(
	endpoint: string,
	line: string,
	timeoutMs: number,
	signal?: AbortSignal,
	fingerprint: (
		candidate: string,
	) => Promise<SocketFingerprint> = safeSocketFingerprint,
): Promise<string> {
	if (signal?.aborted) {
		throw new PresenceTransportError("Socket request aborted.");
	}

	return await new Promise((resolve, reject) => {
		let buffer = "";
		let done = false;
		let postConnectValidated = false;
		let writeDispatched = false;
		let socket: net.Socket | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let fingerprinting = 0;
		let deferred: { error?: Error; value?: string } | undefined;

		const settle = (error?: Error, value?: string) => {
			if (error) reject(error);
			else resolve(value ?? "");
		};
		// Filesystem validation cannot be aborted. Mark the exchange finished at its
		// deadline, but keep its queue work unresolved until the fingerprint lease
		// is released so the next request cannot race into that global lease.
		const finish = (error?: Error, value?: string) => {
			if (done) return;

			done = true;
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			socket?.destroy();
			if (fingerprinting > 0) {
				deferred = { error, value };
				return;
			}
			settle(error, value);
		};
		const abort = () =>
			finish(new PresenceTransportError("Socket request aborted."));
		const fingerprintStage = async (): Promise<SocketFingerprint> => {
			fingerprinting += 1;
			try {
				return await beginFingerprint(endpoint, fingerprint);
			} finally {
				fingerprinting -= 1;
				if (fingerprinting === 0 && deferred) {
					const outcome = deferred;
					deferred = undefined;
					settle(outcome.error, outcome.value);
				}
			}
		};

		// Start before the pre-connect fingerprint: the timeout fences every stage,
		// and a late fingerprint result cannot create a connection after expiry.
		timer = setTimeout(
			() => finish(new PresenceTransportError("Socket request timed out.")),
			timeoutMs,
		);
		timer.unref?.();
		signal?.addEventListener("abort", abort, { once: true });

		void (async () => {
			try {
				const before = await fingerprintStage();
				if (done || signal?.aborted) return abort();

				socket = net.createConnection({ path: endpoint });
				socket.setEncoding("utf8");
				socket.once("error", (error) =>
					finish(new PresenceTransportError(`Socket failure: ${error.message}`)),
				);
				socket.once("end", () =>
					finish(
						new PresenceTransportError(
							"Socket closed before a complete response.",
						),
					),
				);
				socket.once("close", () =>
					finish(
						new PresenceTransportError(
							"Socket closed before a complete response.",
						),
					),
				);
				socket.on("data", (chunk: string) => {
					if (!postConnectValidated || !writeDispatched) {
						finish(
							new PresenceTransportError(
								"Socket response received before request dispatch.",
							),
						);
						return;
					}

					buffer += chunk;
					if (Buffer.byteLength(buffer, "utf8") > 16 * 1024 + 1) {
						finish(
							new PresenceTransportError("Socket response exceeds bound."),
						);
						return;
					}

					const newline = buffer.indexOf("\n");
					if (newline < 0) return;
					if (buffer.length !== newline + 1) {
						finish(
							new PresenceTransportError(
								"Socket sent more than one response line.",
							),
						);
						return;
					}

					finish(undefined, buffer.slice(0, newline));
				});
				socket.once("connect", async () => {
					try {
						if (done || signal?.aborted) return abort();

						const after = await fingerprintStage();
						if (done || signal?.aborted) return abort();
						if (
							before.dev !== after.dev ||
							before.ino !== after.ino ||
							before.uid !== after.uid
						) {
							finish(
								new PresenceTransportError("Socket changed during connection."),
							);
							return;
						}

						postConnectValidated = true;
						writeDispatched = true;
						socket?.write(line, (error) => {
							if (error)
								finish(
									new PresenceTransportError(
										`Socket write failed: ${error.message}`,
									),
								);
						});
					} catch (error) {
						finish(
							error instanceof Error
								? error
								: new PresenceTransportError("Socket validation failed."),
						);
					}
				});
			} catch (error) {
				finish(
					error instanceof Error
						? error
						: new PresenceTransportError("Socket validation failed."),
				);
			}
		})();
	});
}

interface Pending {
	key?: string;
	work: (signal: AbortSignal) => Promise<string>;
	promise: Promise<string>;
	resolve: (value: string) => void;
	reject: (error: unknown) => void;
	settled: boolean;
	deadlineAt?: number;
	timer?: ReturnType<typeof setTimeout>;
}

type Active = {
	control: AbortController;
	item: Pending;
	settled: Promise<void>;
	release: () => void;
};

/** A bounded latest-write-wins queue with optional end-to-end deadlines. Superseded callers settle immediately. */
export class BoundedSocketQueue {
	private queue: Pending[] = [];
	private keyed = new Map<string, Pending>();
	private active: Active | null = null;
	private closed = false;
	private drainPromise: Promise<void> | null = null;

	constructor(private readonly limit: number) {}

	private clearDeadline(item: Pending) {
		if (item.timer) clearTimeout(item.timer);
		item.timer = undefined;
	}

	private resolve(item: Pending, value: string) {
		if (item.settled) return;

		item.settled = true;
		this.clearDeadline(item);
		item.resolve(value);
	}

	private reject(item: Pending, error: unknown) {
		if (item.settled) return;

		item.settled = true;
		this.clearDeadline(item);
		item.reject(error);
	}

	private failed(error: Error): Promise<string> {
		const promise = Promise.reject<string>(error);
		void promise.catch(() => {});
		return promise;
	}

	private expire(item: Pending) {
		if (item.settled) return;

		const active = this.active;
		if (active?.item === item) {
			active.control.abort();
			this.reject(
				item,
				new PresenceTransportError("Socket request timed out."),
			);
			return;
		}

		const index = this.queue.indexOf(item);
		if (index < 0) return;

		this.queue.splice(index, 1);
		if (item.key && this.keyed.get(item.key) === item)
			this.keyed.delete(item.key);
		this.reject(item, new PresenceTransportError("Socket request timed out."));
	}

	/** Abort a keyed request and expose only active actual-work settlement as a dispatch barrier. */
	cancel(key: string): Promise<void> | undefined {
		const active = this.active;
		let settled: Promise<void> | undefined;
		if (active?.item.key === key) {
			active.control.abort();
			this.reject(
				active.item,
				new PresenceTransportError("Socket request cancelled."),
			);
			settled = active.settled;
		}

		// A newer same-key item can be queued behind an in-flight request because
		// active work is no longer in `keyed`. Cancellation fences both versions.
		const item = this.keyed.get(key);
		if (!item || item === active?.item) return settled;

		const index = this.queue.indexOf(item);
		if (index >= 0) this.queue.splice(index, 1);
		if (this.keyed.get(key) === item) this.keyed.delete(key);
		this.reject(item, new PresenceTransportError("Socket request cancelled."));
		return settled;
	}

	enqueue(
		work: (signal: AbortSignal) => Promise<string>,
		key?: string,
		priority = false,
		deadlineAt?: number,
		preemptKeys?: readonly string[],
	): Promise<string> {
		if (this.closed)
			return this.failed(new PresenceTransportError("Socket queue is closed."));

		// Reserve ordinary work synchronously with observer cancellation. The
		// cancelled active exchange remains the physical queue owner until any
		// unabortable fingerprint has settled, while this item is already ahead of
		// observers that arrive after the preemption.
		for (const preemptKey of preemptKeys ?? []) this.cancel(preemptKey);

		const prior = key ? this.keyed.get(key) : undefined;
		if (prior) {
			const index = this.queue.indexOf(prior);
			if (index >= 0) this.queue.splice(index, 1);
			this.keyed.delete(key!);
			this.reject(
				prior,
				new PresenceTransportError("Socket queue coalesced by newer request."),
			);
		}

		if (priority) {
			for (const displaced of this.queue.splice(0)) {
				if (displaced.key) this.keyed.delete(displaced.key);
				this.reject(
					displaced,
					new PresenceTransportError(
						"Socket queue displaced by priority cleanup.",
					),
				);
			}
		} else if (this.queue.length >= this.limit) {
			return this.failed(new PresenceTransportError("Socket queue is full."));
		}

		let resolve!: Pending["resolve"];
		let reject!: Pending["reject"];
		const promise = new Promise<string>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise;
			reject = rejectPromise;
		});
		void promise.catch(() => {});

		const item: Pending = {
			key,
			work,
			promise,
			resolve,
			reject,
			settled: false,
			deadlineAt,
		};
		if (deadlineAt !== undefined) {
			item.timer = setTimeout(
				() => this.expire(item),
				Math.max(0, deadlineAt - Date.now()),
			);
			item.timer.unref?.();
		}

		if (priority) this.queue.unshift(item);
		else this.queue.push(item);
		if (key) this.keyed.set(key, item);
		this.start();
		return promise;
	}

	private start() {
		if (this.drainPromise) return;

		this.drainPromise = this.drain().finally(() => {
			this.drainPromise = null;
			if (this.queue.length && !this.closed) this.start();
		});
	}

	private async drain() {
		while (!this.closed && this.queue.length) {
			const item = this.queue.shift()!;
			if (item.key) this.keyed.delete(item.key);
			if (item.deadlineAt !== undefined && item.deadlineAt <= Date.now()) {
				this.reject(
					item,
					new PresenceTransportError("Socket request timed out."),
				);
				continue;
			}

			let release!: () => void;
			const active = {
				control: new AbortController(),
				item,
				settled: new Promise<void>((resolve) => {
					release = resolve;
				}),
				release,
			};
			this.active = active;
			try {
				this.resolve(item, await item.work(active.control.signal));
			} catch (error) {
				this.reject(item, error);
			} finally {
				active.release();
				if (this.active === active) this.active = null;
			}
		}
	}

	async close(timeoutMs = 0) {
		if (this.closed) return;

		this.closed = true;
		const active = this.active;
		if (active) {
			active.control.abort();
			this.reject(
				active.item,
				new PresenceTransportError("Socket queue closed during active work."),
			);
			if (this.active === active) this.active = null;
		}

		for (const item of this.queue.splice(0)) {
			this.reject(
				item,
				new PresenceTransportError("Socket queue closed before dispatch."),
			);
		}
		this.keyed.clear();

		// An abort-unaware work function may never settle. Immediate close is therefore
		// fire-and-forget; drain still consumes its eventual outcome without dispatching.
		if (timeoutMs <= 0) return;

		const draining = this.drainPromise ?? Promise.resolve();
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			draining,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
				timer.unref?.();
			}),
		]);
		if (timer) clearTimeout(timer);
	}
}

export class HerdrSocketTransport {
	private queue: BoundedSocketQueue;

	constructor(
		private endpoint: string,
		private timeoutMs: number,
		maxQueue: number,
		private readonly fingerprint: (
			candidate: string,
		) => Promise<SocketFingerprint> = safeSocketFingerprint,
	) {
		this.queue = new BoundedSocketQueue(maxQueue);
	}

	request(
		line: string,
		key?: string,
		priority = false,
		timeoutMs = this.timeoutMs,
		preemptKeys?: readonly string[],
	) {
		const deadlineAt = Date.now() + timeoutMs;
		return this.queue.enqueue(
			(signal) =>
				exchange(
					this.endpoint,
					line,
					Math.max(0, deadlineAt - Date.now()),
					signal,
					this.fingerprint,
				),
			key,
			priority,
			deadlineAt,
			preemptKeys,
		);
	}

	cancel(key: string): Promise<void> | undefined {
		return this.queue.cancel(key);
	}

	close(timeoutMs = this.timeoutMs) {
		return this.queue.close(timeoutMs);
	}
}
