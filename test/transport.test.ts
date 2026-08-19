import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import { join } from "node:path";
import {
	safeSocketFingerprint,
	type SocketFingerprint,
} from "../src/identity.js";
import { BoundedSocketQueue, HerdrSocketTransport } from "../src/transport.js";

const cleanup: Array<() => Promise<void>> = [];
const fixedFingerprint = async (): Promise<SocketFingerprint> => ({
	dev: 1,
	ino: 1,
	uid: 1,
});

afterEach(async () => {
	while (cleanup.length) await cleanup.pop()!();
});

async function temporarySocketPath(name: string): Promise<string> {
	const directory = await fs.mkdtemp(join(os.tmpdir(), `herdr-${name}-`));
	cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
	return join(directory, "socket");
}

async function listen(
	path: string,
	onConnection: (socket: net.Socket) => void,
): Promise<net.Server> {
	const server = net.createServer(onConnection);
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, resolve);
	});
	await fs.chmod(path, 0o600);
	cleanup.push(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	return server;
}

function readRequest(socket: net.Socket, respond: () => void): void {
	socket.once("data", respond);
}

describe("transport integration: real Unix sockets", () => {
	test("accepts a fragmented single-line response", async () => {
		const path = await temporarySocketPath("fragmented-response");
		await listen(path, (socket) =>
			readRequest(socket, () => {
				socket.write('{"id":"x",');
				setTimeout(() => socket.end('"result":{"type":"ok"}}\n'), 1);
			}),
		);

		const transport = new HerdrSocketTransport(path, 100, 1, fixedFingerprint);
		await expect(transport.request("request\n")).resolves.toBe(
			'{"id":"x","result":{"type":"ok"}}',
		);
		await transport.close();
	});

	test("rejects multiple or trailing response lines sent in one response", async () => {
		for (const response of ["first\nsecond\n", "first\ntrailing"]) {
			const path = await temporarySocketPath("extra-response");
			await listen(path, (socket) =>
				readRequest(socket, () => socket.end(response)),
			);
			const transport = new HerdrSocketTransport(
				path,
				100,
				1,
				fixedFingerprint,
			);
			await expect(transport.request("request\n")).rejects.toThrow(
				"more than one response line",
			);
			await transport.close();
		}
	});

	test("bounds responses by UTF-8 bytes rather than JavaScript character count", async () => {
		const path = await temporarySocketPath("oversized-response");
		await listen(path, (socket) =>
			readRequest(socket, () => socket.end(`${"😀".repeat(4_097)}\n`)),
		);

		const transport = new HerdrSocketTransport(path, 100, 1, fixedFingerprint);
		await expect(transport.request("request\n")).rejects.toThrow(
			"response exceeds bound",
		);
		await transport.close();
	});

	test("rejects EOF before a newline-delimited response is complete", async () => {
		const path = await temporarySocketPath("eof-response");
		await listen(path, (socket) =>
			readRequest(socket, () => socket.end('{"id":"x"}')),
		);

		const transport = new HerdrSocketTransport(path, 100, 1, fixedFingerprint);
		await expect(transport.request("request\n")).rejects.toThrow(
			"closed before a complete response",
		);
		await transport.close();
	});

	test("rejects a socket whose fingerprint changes between validation phases", async () => {
		const path = await temporarySocketPath("changed-fingerprint");
		await listen(path, (socket) =>
			readRequest(socket, () => socket.end("ok\n")),
		);
		let calls = 0;
		const changingFingerprint = async (): Promise<SocketFingerprint> => {
			calls += 1;
			return { dev: 1, ino: calls, uid: 1 };
		};

		const transport = new HerdrSocketTransport(
			path,
			100,
			1,
			changingFingerprint,
		);
		await expect(transport.request("request\n")).rejects.toThrow(
			"changed during connection",
		);
		expect(calls).toBe(2);
		await transport.close();
	});

	test("surfaces a refused or missing Unix-socket connection as a transport failure", async () => {
		const path = await temporarySocketPath("refused-connection");
		const transport = new HerdrSocketTransport(path, 100, 1, fixedFingerprint);

		await expect(transport.request("request\n")).rejects.toThrow(
			"Socket failure:",
		);
		await transport.close();
	});

	test("recovers with a later request after a socket-level EOF failure", async () => {
		const path = await temporarySocketPath("recovery");
		let connections = 0;
		await listen(path, (socket) =>
			readRequest(socket, () => {
				connections += 1;
				if (connections === 1) socket.end("incomplete");
				else socket.end("ok\n");
			}),
		);

		const transport = new HerdrSocketTransport(path, 100, 2, fixedFingerprint);
		await expect(transport.request("first\n")).rejects.toThrow(
			"closed before a complete response",
		);
		await expect(transport.request("second\n")).resolves.toBe("ok");
		expect(connections).toBe(2);
		await transport.close();
	});

	test("rejects an unsolicited response before fingerprint validation and request dispatch", async () => {
		const path = await temporarySocketPath("unsolicited-response");
		await listen(path, (socket) => socket.end('{"id":"x","result":{}}\n'));

		let calls = 0;
		const delayedPostConnectFingerprint =
			async (): Promise<SocketFingerprint> => {
				calls += 1;
				if (calls === 2)
					await new Promise((resolve) => setTimeout(resolve, 25));
				return { dev: 1, ino: 1, uid: 1 };
			};
		const transport = new HerdrSocketTransport(
			path,
			100,
			1,
			delayedPostConnectFingerprint,
		);
		await expect(transport.request("request\n")).rejects.toThrow(
			"before request dispatch",
		);
		await transport.close();
	});

	test("uses the real owner-only socket fingerprint validation", async () => {
		const path = await temporarySocketPath("fingerprint");
		await listen(path, (socket) =>
			readRequest(socket, () => socket.end("ok\n")),
		);

		const entry = await fs.lstat(path);
		await expect(safeSocketFingerprint(path)).resolves.toEqual({
			dev: entry.dev,
			ino: entry.ino,
			uid: entry.uid,
		});
	});

	test("rejects ambiguous, symlinked, and replaceable socket paths", async () => {
		const outer = await fs.mkdtemp(join(os.tmpdir(), "herdr-unsafe-path-"));
		const target = join(outer, "target");
		const link = join(outer, "link");
		const nested = join(outer, "nested");
		cleanup.push(() => fs.rm(outer, { recursive: true, force: true }));
		await fs.mkdir(target, { mode: 0o700 });
		await fs.mkdir(nested, { mode: 0o700 });
		await fs.symlink(target, link);
		await listen(join(target, "socket"), (socket) =>
			readRequest(socket, () => socket.end("ok\n")),
		);

		await expect(
			safeSocketFingerprint(`${nested}/../target/socket`),
		).rejects.toThrow("ambiguous traversal");
		await expect(safeSocketFingerprint(join(link, "socket"))).rejects.toThrow(
			"symlink",
		);
		await fs.chmod(outer, 0o777);
		await expect(safeSocketFingerprint(join(target, "socket"))).rejects.toThrow(
			"replaceable",
		);
	});
});

describe("transport module: queue and deadline behavior", () => {
	test("continues FIFO dispatch after an active request fails", async () => {
		const queue = new BoundedSocketQueue(2);
		const started: string[] = [];
		const failed = queue.enqueue(async () => {
			started.push("failed");
			throw new Error("socket failed");
		});
		const recovered = queue.enqueue(async () => {
			started.push("recovered");
			return "recovered";
		});

		await expect(failed).rejects.toThrow("socket failed");
		await expect(recovered).resolves.toBe("recovered");
		expect(started).toEqual(["failed", "recovered"]);
		await queue.close();
	});

	test("priority cleanup displaces saturated pending work", async () => {
		const queue = new BoundedSocketQueue(1);
		let releaseActive!: () => void;
		const started: string[] = [];
		const active = queue.enqueue(async () => {
			started.push("active");
			await new Promise<void>((resolve) => {
				releaseActive = resolve;
			});
			return "active";
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		const pending = queue.enqueue(async () => "pending", "state");
		const priority = queue.enqueue(
			async () => {
				started.push("release");
				return "release";
			},
			"release",
			true,
		);

		await expect(pending).rejects.toThrow("priority cleanup");
		releaseActive();
		await expect(active).resolves.toBe("active");
		await expect(priority).resolves.toBe("release");
		expect(started).toEqual(["active", "release"]);
		await queue.close();
	});

	test("times out active work and dispatches the next FIFO item", async () => {
		const queue = new BoundedSocketQueue(2);
		const started: string[] = [];
		const active = queue.enqueue(
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					started.push("active");
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
			undefined,
			false,
			Date.now() + 20,
		);
		const pending = queue.enqueue(async () => {
			started.push("pending");
			return "pending";
		});

		await expect(active).rejects.toThrow("timed out");
		await expect(pending).resolves.toBe("pending");
		expect(started).toEqual(["active", "pending"]);
		await queue.close();
	});

	test("cancels queued keyed work, settles its caller, and preserves later FIFO work", async () => {
		const queue = new BoundedSocketQueue(3);
		const started: string[] = [];
		let releaseActive!: () => void;
		let activeStarted!: () => void;
		const activeReady = new Promise<void>((resolve) => {
			activeStarted = resolve;
		});
		const active = queue.enqueue(async () => {
			started.push("active");
			activeStarted();
			await new Promise<void>((resolve) => {
				releaseActive = resolve;
			});
			return "active";
		}, "other-active");
		await activeReady;

		const cancelled = queue.enqueue(async () => {
			started.push("cancelled");
			return "cancelled";
		}, "workspace");
		const later = queue.enqueue(async () => {
			started.push("later");
			return "later";
		}, "later");

		queue.cancel("workspace");
		await expect(cancelled).rejects.toThrow("cancelled");
		expect(started).toEqual(["active"]);

		releaseActive();
		await expect(active).resolves.toBe("active");
		await expect(later).resolves.toBe("later");
		expect(started).toEqual(["active", "later"]);
		await queue.close();
	});

	test("cancels active abort-aware keyed work and recovers FIFO dispatch", async () => {
		const queue = new BoundedSocketQueue(2);
		const started: string[] = [];
		let activeStarted!: () => void;
		const activeReady = new Promise<void>((resolve) => {
			activeStarted = resolve;
		});
		const active = queue.enqueue(
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					started.push("workspace");
					activeStarted();
					signal.addEventListener(
						"abort",
						() => reject(new Error("work observed abort")),
						{ once: true },
					);
				}),
			"workspace",
		);
		await activeReady;

		const later = queue.enqueue(async () => {
			started.push("later");
			return "later";
		}, "later");

		queue.cancel("workspace");
		await expect(active).rejects.toThrow("cancelled");
		await expect(later).resolves.toBe("later");
		expect(started).toEqual(["workspace", "later"]);
		await queue.close();
	});

	test("cancels active and newer queued work with the same key while preserving priority work", async () => {
		const queue = new BoundedSocketQueue(3);
		const started: string[] = [];
		let activeStarted!: () => void;
		const activeReady = new Promise<void>((resolve) => {
			activeStarted = resolve;
		});
		const active = queue.enqueue(
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					started.push("active");
					activeStarted();
					signal.addEventListener(
						"abort",
						() => reject(new Error("work observed abort")),
						{ once: true },
					);
				}),
			"workspace",
		);
		await activeReady;
		const priority = queue.enqueue(async () => {
			started.push("priority");
			return "priority";
		}, "priority", true);
		const newer = queue.enqueue(async () => {
			started.push("newer");
			return "newer";
		}, "workspace");
		const later = queue.enqueue(async () => {
			started.push("later");
			return "later";
		}, "later");

		queue.cancel("workspace");
		await expect(active).rejects.toThrow("cancelled");
		await expect(newer).rejects.toThrow("cancelled");
		await expect(priority).resolves.toBe("priority");
		await expect(later).resolves.toBe("later");
		expect(started).toEqual(["active", "priority", "later"]);
		await queue.close();
	});

	test("does not cancel active or priority work with different keys", async () => {
		const queue = new BoundedSocketQueue(2);
		const started: string[] = [];
		let releaseActive!: () => void;
		let activeStarted!: () => void;
		const activeReady = new Promise<void>((resolve) => {
			activeStarted = resolve;
		});
		const active = queue.enqueue(async () => {
			started.push("other-active");
			activeStarted();
			await new Promise<void>((resolve) => {
				releaseActive = resolve;
			});
			return "other-active";
		}, "other-active");
		await activeReady;

		const priority = queue.enqueue(
			async () => {
				started.push("priority");
				return "priority";
			},
			"priority",
			true,
		);

		queue.cancel("workspace");
		releaseActive();
		await expect(active).resolves.toBe("other-active");
		await expect(priority).resolves.toBe("priority");
		expect(started).toEqual(["other-active", "priority"]);
		await queue.close();
	});

	test("coalesces keyed work and rejects queued work during close", async () => {
		const queue = new BoundedSocketQueue(2);
		const active = queue.enqueue(
			(signal) =>
				new Promise<string>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
				}),
		);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const first = queue.enqueue(async () => "old", "state");
		const latest = queue.enqueue(async () => "latest", "state");
		const queued = queue.enqueue(async () => "never", "other");

		await queue.close(20);
		await expect(active).rejects.toThrow("closed during active work");
		await expect(first).rejects.toThrow("coalesced");
		await expect(latest).rejects.toThrow("closed before dispatch");
		await expect(queued).rejects.toThrow("closed before dispatch");
	});

	test("immediate close does not wait for abort-unaware active work", async () => {
		const queue = new BoundedSocketQueue(1);
		let started!: () => void;
		let finish!: (value: string) => void;
		const began = new Promise<void>((resolve) => {
			started = resolve;
		});
		const work = new Promise<string>((resolve) => {
			finish = resolve;
		});
		const active = queue.enqueue(async () => {
			started();
			return await work;
		});
		await began;

		await expect(
			Promise.race([
				queue.close(0).then(() => "closed"),
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("timed out"), 50),
				),
			]),
		).resolves.toBe("closed");
		await expect(active).rejects.toThrow("closed during active work");
		finish("late");
	});

	test("prevents abandoned work from regaining dispatch authority after close", async () => {
		const queue = new BoundedSocketQueue(2);
		const dispatched: string[] = [];
		let release!: () => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const abandoned = queue.enqueue(async (signal) => {
			markStarted();
			await gate;
			if (!signal.aborted) dispatched.push("authority");
			return "late";
		});
		await started;
		const queued = queue.enqueue(async () => {
			dispatched.push("queued-authority");
			return "queued";
		}, "authority");

		await queue.close(0);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(dispatched).toEqual([]);
		await expect(abandoned).rejects.toThrow("closed during active work");
		await expect(queued).rejects.toThrow("closed before dispatch");
	});
});

describe("transport integration: fingerprint deadlines", () => {
	test("does not connect after a pre-connect fingerprint times out", async () => {
		const path = await temporarySocketPath("fingerprint-deadline");
		let connections = 0;
		await listen(path, () => {
			connections += 1;
		});
		const delayedFingerprint = async (): Promise<SocketFingerprint> => {
			await new Promise((resolve) => setTimeout(resolve, 40));
			return { dev: 1, ino: 1, uid: 1 };
		};

		const transport = new HerdrSocketTransport(path, 10, 1, delayedFingerprint);
		await expect(transport.request("request\n")).rejects.toThrow("timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(connections).toBe(0);
		await transport.close();
	});

	test("holds the process-wide fingerprint lease across endpoint changes", async () => {
		const directory = await fs.mkdtemp(
			join(os.tmpdir(), "herdr-process-fingerprint-lease-"),
		);
		cleanup.push(() => fs.rm(directory, { recursive: true, force: true }));
		let release!: () => void;
		let firstCalls = 0;
		let secondCalls = 0;
		const unresolved = new Promise<SocketFingerprint>((resolve) => {
			release = () => resolve({ dev: 1, ino: 1, uid: 1 });
		});
		const first = new HerdrSocketTransport(
			join(directory, "first"),
			5,
			1,
			() => {
				firstCalls += 1;
				return unresolved;
			},
		);
		const second = new HerdrSocketTransport(
			join(directory, "second"),
			5,
			1,
			async () => {
				secondCalls += 1;
				return { dev: 1, ino: 1, uid: 1 };
			},
		);

		await expect(first.request("request\n")).rejects.toThrow("timed out");
		await expect(second.request("request\n")).rejects.toThrow(
			"already unresolved",
		);
		expect(firstCalls).toBe(1);
		expect(secondCalls).toBe(0);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(second.request("request\n")).rejects.toThrow();
		expect(secondCalls).toBe(1);
		await first.close(0);
		await second.close(0);
	});

	test("fences a timed-out post-connect fingerprint until it settles, then recovers", async () => {
		const path = await temporarySocketPath("post-fingerprint-lease");
		await listen(path, (socket) =>
			readRequest(socket, () => socket.end("ok\n")),
		);
		let release!: () => void;
		let calls = 0;
		const unresolved = new Promise<SocketFingerprint>((resolve) => {
			release = () => resolve({ dev: 1, ino: 1, uid: 1 });
		});
		const fingerprint = (): Promise<SocketFingerprint> => {
			calls += 1;
			return calls === 2
				? unresolved
				: Promise.resolve({ dev: 1, ino: 1, uid: 1 });
		};

		const transport = new HerdrSocketTransport(path, 10, 2, fingerprint);
		await expect(transport.request("request\n")).rejects.toThrow("timed out");
		await expect(transport.request("request\n")).rejects.toThrow(
			"already unresolved",
		);
		release();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await expect(transport.request("request\n")).resolves.toBe("ok");
		expect(calls).toBe(4);
		await transport.close();
	});
});
