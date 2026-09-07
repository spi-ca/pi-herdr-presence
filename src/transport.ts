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
	deadlineAt?: number,
	signal?: AbortSignal,
	/** Returns false when cancellation/expiry fenced this request before its write. */
	markDispatched: () => boolean = () => true,
	fingerprint: (
		candidate: string,
	) => Promise<SocketFingerprint> = safeSocketFingerprint,
): Promise<string> {
	if (signal?.aborted) {
		throw new PresenceTransportError("Socket request aborted.");
	}
	if (timeoutMs <= 0 || (deadlineAt !== undefined && deadlineAt <= Date.now())) {
		throw new PresenceTransportError("Socket request timed out.");
	}

	return await new Promise((resolve, reject) => {
		const expired = () => deadlineAt !== undefined && deadlineAt <= Date.now();
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
				if (expired()) return finish(new PresenceTransportError("Socket request timed out."));
				const before = await fingerprintStage();
				if (done || signal?.aborted) return abort();
				if (expired()) return finish(new PresenceTransportError("Socket request timed out."));

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
						if (expired()) return finish(new PresenceTransportError("Socket request timed out."));

						const after = await fingerprintStage();
						if (done || signal?.aborted) return abort();
						if (expired()) return finish(new PresenceTransportError("Socket request timed out."));
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
						// The post-connect fingerprint can consume the entire attempt.
						// Recheck at the dispatch boundary: a timed-out request must not
						// become ambiguous by writing after its deadline.
						if (expired())
							return finish(new PresenceTransportError("Socket request timed out."));
						if (signal?.aborted) return abort();
						try {
							socket?.write(line, (error) => {
								if (error)
									finish(
										new PresenceTransportError(
											`Socket write failed: ${error.message}`,
										),
									);
							});
						} catch (error) {
							return finish(error instanceof Error
								? new PresenceTransportError(`Socket write failed: ${error.message}`)
								: new PresenceTransportError("Socket write failed."));
						}
						// `write()` accepted the complete line synchronously. This is the
						// only point at which notification delivery becomes ambiguous.
						if (!markDispatched()) return abort();
						writeDispatched = true;
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

export type QueueLane = "protected" | "actionable" | "replaceable";
export type QueueReleaseReason = "timed_out" | "cancelled" | "pre_dispatch_failure" | "coalesced" | "priority_cleanup" | "actionable_displacement" | "closed";
export type QueueDisposition =
	| { status: "dispatched" }
	| { status: "released"; reason: QueueReleaseReason };

interface Pending {
	key?: string;
	lane: QueueLane;
	work: (signal: AbortSignal, markDispatched: () => boolean) => Promise<string>;
	promise: Promise<string>;
	resolve: (value: string) => void;
	reject: (error: unknown) => void;
	settled: boolean;
	deadlineAt?: number;
	timer?: ReturnType<typeof setTimeout>;
	disposition?: (disposition: QueueDisposition) => void;
	/** Set only at the physical socket-write boundary. */
	dispatched: boolean;
	disposed: boolean;
}

type Active = {
	control: AbortController;
	item: Pending;
	settled: Promise<void>;
	release: () => void;
	timer?: ReturnType<typeof setTimeout>;
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

	private admission(callback: ((admitted: boolean) => void) | undefined, admitted: boolean) {
		try { callback?.(admitted); } catch { /* user callbacks cannot poison queue state */ }
	}

	private failed(error: Error, onAdmission?: (admitted: boolean) => void): Promise<string> {
		this.admission(onAdmission, false);
		const promise = Promise.reject<string>(error);
		void promise.catch(() => {});
		return promise;
	}

	/**
	 * Detach state before scheduling user code. A microtask ensures a callback
	 * cannot observe an in-progress coalesce, displacement, close, or admission.
	 */
	private dispose(item: Pending, disposition: QueueDisposition) {
		if (item.disposed) return;
		item.disposed = true;
		this.clearDeadline(item);
		queueMicrotask(() => {
			try { item.disposition?.(disposition); } catch { /* callback failures are output-only */ }
		});
	}

	private releaseBeforeDispatch(item: Pending, error: Error, reason: QueueReleaseReason) {
		const index = this.queue.indexOf(item);
		if (index >= 0) this.queue.splice(index, 1);
		if (item.key && this.keyed.get(item.key) === item) this.keyed.delete(item.key);
		this.reject(item, error);
		this.dispose(item, { status: "released", reason });
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
			if (!item.dispatched)
				this.dispose(item, { status: "released", reason: "timed_out" });
			return;
		}

		if (!this.queue.includes(item)) return;
		this.releaseBeforeDispatch(
			item,
			new PresenceTransportError("Socket request timed out."),
			"timed_out",
		);
	}

	/** Whether a keyed request can still be cancelled before its physical write. */
	canCancelBeforeDispatch(key: string): boolean {
		const active = this.active;
		if (active?.item.key === key) return !active.item.dispatched;
		return this.keyed.has(key);
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
			if (!active.item.dispatched)
				this.dispose(active.item, { status: "released", reason: "cancelled" });
			settled = active.settled;
		}

		// A newer same-key item can be queued behind an in-flight request because
		// active work is no longer in `keyed`. Cancellation fences both versions.
		const item = this.keyed.get(key);
		if (!item || item === active?.item) return settled;

		this.releaseBeforeDispatch(
			item,
			new PresenceTransportError("Socket request cancelled."),
			"cancelled",
		);
		return settled;
	}

	enqueue(
		work: (signal: AbortSignal, markDispatched: () => boolean) => Promise<string>,
		key?: string,
		priority = false,
		deadlineAt?: number,
		preemptKeys?: readonly string[],
		lane: QueueLane = "replaceable",
		/** Called synchronously: true only after this exact item enters the queue. */
		onAdmission?: (admitted: boolean) => void,
		/** Exactly once after admission: dispatch or release before physical dispatch. */
		onDisposition?: (disposition: QueueDisposition) => void,
		/** Actionable callers opt into a finite residency deadline; legacy actionable work remains compatible. */
		queueDeadlineAt?: number,
	): Promise<string> {
		if (this.closed)
			return this.failed(new PresenceTransportError("Socket queue is closed."), onAdmission);
		// Reject before preemption, coalescing, allocation, or drain scheduling so
		// an expired lifecycle deadline can never start remote work.
		if (lane !== "actionable" && deadlineAt !== undefined && deadlineAt <= Date.now())
			return this.failed(new PresenceTransportError("Socket request timed out."), onAdmission);

		// Non-priority admission must reject before mutating an observer target.
		// The active item is intentionally absent from `keyed`, so inspect both
		// locations for shared-key conflicts and attempted observer preemption.
		if (!priority) {
			const active = this.active?.item;
			const queued = key ? this.keyed.get(key) : undefined;
			if (
				key &&
				((active?.key === key && active.lane !== lane) ||
					(queued && queued.lane !== lane))
			)
				return this.failed(
					new PresenceTransportError("Socket queue key lane conflict."),
					onAdmission,
				);

			// Actionable admission is queue-only and deliberately ignores supplied
			// preemption keys. Other lanes can preempt workspace observers only.
			if (lane !== "actionable") {
				for (const preemptKey of preemptKeys ?? []) {
					const activeTarget =
						active?.key === preemptKey ? active : undefined;
					const queuedTarget = this.keyed.get(preemptKey);
					if (
						(activeTarget && activeTarget.lane !== "replaceable") ||
						(queuedTarget && queuedTarget.lane !== "replaceable")
					)
						return this.failed(
							new PresenceTransportError(
								"Socket queue preemption target lane conflict.",
							),
							onAdmission,
						);
				}
			}
		}

		// Reserve ordinary work synchronously with observer cancellation. The
		// cancelled active exchange remains the physical queue owner until any
		// unabortable fingerprint has settled, while this item is already ahead of
		// observers that arrive after the preemption. Priority cleanup explicitly
		// bypasses this preflight and retains its established flush semantics.
		for (const preemptKey of lane === "actionable" ? [] : (preemptKeys ?? []))
			this.cancel(preemptKey);

		const prior = key ? this.keyed.get(key) : undefined;
		// Latest-write-wins is safe only within a lane. A lower-priority lane
		// must not use a shared key to displace protected/actionable work.
		// Priority cleanup intentionally retains its flush-all admission behavior.
		if (prior && prior.lane !== lane && !priority)
			return this.failed(
				new PresenceTransportError("Socket queue key lane conflict."),
				onAdmission,
			);
		if (prior) {
			const index = this.queue.indexOf(prior);
			if (index >= 0) this.queue.splice(index, 1);
			this.releaseBeforeDispatch(
				prior,
				new PresenceTransportError("Socket queue coalesced by newer request."),
				"coalesced",
			);
		}

		if (priority) {
			// Cleanup remains the sole flush-all admission path.
			for (const displaced of [...this.queue]) {
				this.releaseBeforeDispatch(
					displaced,
					new PresenceTransportError("Socket queue displaced by priority cleanup."),
					"priority_cleanup",
				);
			}
		} else if (this.queue.length >= this.limit) {
			// Actionable notifications may make room for exactly one queued
			// replaceable projection, but never abort active work or evict a
			// protected/actionable request.
			const replaceable = lane === "actionable"
				? this.queue.findIndex((item) => item.lane === "replaceable")
				: -1;
			if (replaceable < 0)
				return this.failed(new PresenceTransportError("Socket queue is full."), onAdmission);
			const displaced = this.queue[replaceable];
			if (displaced)
				this.releaseBeforeDispatch(
					displaced,
					new PresenceTransportError("Socket queue displaced by actionable notification."),
					"actionable_displacement",
				);
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
			lane,
			work,
			promise,
			resolve,
			reject,
			settled: false,
			deadlineAt: lane === "actionable" ? queueDeadlineAt : deadlineAt,
			disposition: onDisposition,
			dispatched: false,
			disposed: false,
		};
		if (item.deadlineAt !== undefined) {
			item.timer = setTimeout(
				() => this.expire(item),
				Math.max(0, item.deadlineAt - Date.now()),
			);
			item.timer.unref?.();
		}

		if (priority) this.queue.unshift(item);
		else this.queue.push(item);
		if (key) this.keyed.set(key, item);
		this.admission(onAdmission, true);
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
			if (item.key && this.keyed.get(item.key) === item) this.keyed.delete(item.key);
			if (item.deadlineAt !== undefined && item.deadlineAt <= Date.now()) {
				this.reject(item, new PresenceTransportError("Socket request timed out."));
				this.dispose(item, { status: "released", reason: "timed_out" });
				continue;
			}
			let release!: () => void;
			const active: Active = {
				control: new AbortController(),
				item,
				settled: new Promise<void>((resolve) => {
					release = resolve;
				}),
				release,
			};
			// The item is active (but no longer keyed) before physical dispatch. Its
			// queue-age timer remains live through fingerprinting, connect, and the
			// final pre-write validation.
			this.active = active;
			const markDispatched = () => {
				if (this.active !== active || this.closed || active.control.signal.aborted || item.settled)
					return false;
				item.dispatched = true;
				this.dispose(item, { status: "dispatched" });
				return true;
			};
			try {
				if (this.closed || active.control.signal.aborted) {
					if (!item.settled)
						this.reject(item, new PresenceTransportError("Socket request cancelled."));
					if (!item.dispatched)
						this.dispose(item, { status: "released", reason: "cancelled" });
					continue;
				}
				this.resolve(item, await item.work(active.control.signal, markDispatched));
			} catch (error) {
				this.reject(item, error);
			} finally {
				// A work function that failed, was aborted, or returned without reaching
				// its explicit physical-write marker never committed its reservation.
				if (!item.dispatched && !item.disposed)
					this.dispose(item, { status: "released", reason: "pre_dispatch_failure" });
				if (active.timer) clearTimeout(active.timer);
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
			if (active.timer) clearTimeout(active.timer);
			active.control.abort();
			this.reject(
				active.item,
				new PresenceTransportError("Socket queue closed during active work."),
			);
			if (!active.item.dispatched)
				this.dispose(active.item, { status: "released", reason: "closed" });
			if (this.active === active) this.active = null;
		}

		for (const item of [...this.queue]) {
			this.releaseBeforeDispatch(
				item,
				new PresenceTransportError("Socket queue closed before dispatch."),
				"closed",
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
		/** Optional caller-owned absolute deadline; relative callers remain compatible. */
		deadlineAt = Date.now() + timeoutMs,
		lane: QueueLane = "replaceable",
		/** Synchronous queue-admission receipt; post-dispatch delivery remains unknown. */
		onAdmission?: (admitted: boolean) => void,
		/** Queue lifetime disposition; active delivery failure is intentionally absent. */
		onDisposition?: (disposition: QueueDisposition) => void,
		/** Optional finite actionable residency deadline. */
		actionableQueueDeadlineAt?: number,
	) {
		const queuedAt = Date.now();
		// Protected and replaceable lifecycle work retains its caller-owned absolute
		// deadline. An actionable toast instead reserves bounded queue capacity until
		// dispatch, then receives its own full socket attempt.
		const queueDeadlineAt = lane === "actionable"
			? actionableQueueDeadlineAt
			: Math.min(deadlineAt, queuedAt + timeoutMs);
		if (
			!Number.isFinite(timeoutMs) ||
			timeoutMs <= 0 ||
			(queueDeadlineAt !== undefined &&
				(!Number.isFinite(queueDeadlineAt) || queueDeadlineAt <= queuedAt))
		) {
			try { onAdmission?.(false); } catch { /* admission observers are output-only */ }
			const failed = Promise.reject<string>(new PresenceTransportError("Socket request timed out."));
			void failed.catch(() => {});
			return failed;
		}
		return this.queue.enqueue(
			(signal, markDispatched) => {
				const dispatchedAt = Date.now();
				const attemptDeadlineAt = lane === "actionable"
					? dispatchedAt + timeoutMs
					: queueDeadlineAt!;
				const remaining = attemptDeadlineAt - dispatchedAt;
				if (remaining <= 0)
					return Promise.reject(new PresenceTransportError("Socket request timed out."));
				return exchange(
					this.endpoint,
					line,
					remaining,
					attemptDeadlineAt,
					signal,
					markDispatched,
					this.fingerprint,
				);
			},
			key,
			priority,
			queueDeadlineAt,
			preemptKeys,
			lane,
			onAdmission,
			onDisposition,
			queueDeadlineAt,
		);
	}

	canCancelBeforeDispatch(key: string): boolean {
		return this.queue.canCancelBeforeDispatch(key);
	}

	cancel(key: string): Promise<void> | undefined {
		return this.queue.cancel(key);
	}

	close(timeoutMs = this.timeoutMs) {
		return this.queue.close(timeoutMs);
	}
}
