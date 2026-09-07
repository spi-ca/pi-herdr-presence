import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
	EVENT_NAMES,
	createPresenceProducer,
	type PresenceProducerHandle,
	type PresenceSource,
} from "@pi/presence";
import { resolvePresenceConfig } from "../src/config.js";
import { PresenceRuntime, type LongRunningScheduler } from "../src/runtime.js";
import { fakeSocket } from "./helpers/fake-socket.js";

type Request = {
	id: string;
	method?: string;
	params?: Record<string, unknown>;
};
type Harness = {
	runtime: PresenceRuntime;
	requests: Request[];
	producer(source: PresenceSource): PresenceProducerHandle;
};
const environmentKeys = [
	"HERDR_ENV",
	"HERDR_SOCKET_PATH",
	"HERDR_PANE_ID",
	"HERDR_WORKSPACE_ID",
	"PI_CODING_AGENT_DIR",
] as const;
const sleep = (ms = 20) =>
	new Promise<void>((done) => setTimeout(done, ms));
let previous = Promise.resolve();
function serial(name: string, body: () => Promise<void>) {
	let release!: () => void;
	const mine = new Promise<void>((done) => { release = done; });
	const prior = previous;
	previous = mine;
	test(name, async () => {
		await prior;
		try { await body(); } finally { release(); }
	});
}
async function eventually(assertion: () => void) {
	let error: unknown;
	for (let i = 0; i < 60; i += 1) {
		try {
			assertion();
			return;
		} catch (caught) {
			error = caught;
		}
		await sleep();
	}
	throw error;
}
function eventBus() {
	const listeners = new Map<
		string,
		Array<(payload: unknown) => void>
	>();
	return {
		on(name: string, listener: (payload: unknown) => void) {
			listeners.set(name, [
				...(listeners.get(name) ?? []),
				listener,
			]);
		},
		emit(name: string, payload: unknown) {
			for (const listener of listeners.get(name) ?? [])
				listener(payload);
		},
	};
}
async function withRuntime(
	config: Partial<ReturnType<typeof resolvePresenceConfig>>,
	body: (h: Harness) => Promise<void>,
	longRunningScheduler?: LongRunningScheduler,
	beforeStart?: (h: Harness) => void,
	startContext: object = { mode: "tui", sessionManager: { getSessionId: () => "session" } },
) {
	const directory = await fs.mkdtemp(
		join(os.tmpdir(), "herdr-v2-actionable-"),
	);
	const socketPath = join(directory, "socket");
	const requests: Request[] = [];
	const server = await fakeSocket(socketPath, (line) => {
		const request = JSON.parse(line) as Request;
		requests.push(request);
		return JSON.stringify({
			id: request.id,
			result: {},
		});
	});
	const saved = Object.fromEntries(
		environmentKeys.map((key) => [
			key,
			process.env[key],
		]),
	);
	const events = eventBus();
	const producers: PresenceProducerHandle[] = [];
	const runtime = new PresenceRuntime(
		{
			getAllTools: () => [],
			events,
		} as never,
		{
			...{ ...resolvePresenceConfig(), soleReporter: true },
			maxQueue: 128,
			...config,
		},
		undefined,
		undefined,
		longRunningScheduler,
	);
	try {
		Object.assign(process.env, {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: socketPath,
			HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace",
			PI_CODING_AGENT_DIR: join(directory, "absent"),
		});
		for (const name of [
			EVENT_NAMES.state,
			EVENT_NAMES.terminal,
			EVENT_NAMES.withdraw,
		])
			events.on(name, (payload) =>
				runtime.handlePresenceEvent(name, payload),
			);
		const h: Harness = {
			runtime,
			requests,
			producer(source) {
				const producer = createPresenceProducer({
					source,
					emit: events.emit,
				});
				if (!producer || !producer.activate())
					throw new Error(`Cannot activate ${source}.`);
				producers.push(producer);
				return producer;
			},
		};
		beforeStart?.(h);
		await runtime.startSession(startContext);
		await body(h);
	} finally {
		try {
			await runtime.shutdownSession((runtime as unknown as { context: object }).context);
		} finally {
			for (const producer of producers) producer.deactivate();
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			await server.close();
			await fs.rm(directory, {
				recursive: true,
				force: true,
			});
		}
	}
}
const notices = (requests: Request[]) =>
	requests.filter(
		(request) => request.method === "notification.show",
	);
const metas = (requests: Request[]) =>
	requests.filter((request) => request.method === "pane.report_metadata");
const tokens = (request: Request) =>
	request.params?.tokens as Record<string, string | null>;
const attention = (requests: Request[], value: string) =>
	metas(requests).some((request) => tokens(request).v2_attention === value);

class ManualLongRunningScheduler implements LongRunningScheduler {
	private time = 0;
	private nextId = 0;
	private readonly timers = new Map<number, { due: number; callback: () => void }>();
	now() { return this.time; }
	setTimeout(callback: () => void, delayMs: number) {
		const id = ++this.nextId;
		this.timers.set(id, { due: this.time + delayMs, callback });
		return id as unknown as ReturnType<typeof setTimeout>;
	}
	clearTimeout(timer: ReturnType<typeof setTimeout>) {
		this.timers.delete(timer as unknown as number);
	}
	elapse(milliseconds: number) { this.time += milliseconds; }
	advance(milliseconds: number) {
		const target = this.time + milliseconds;
		while (true) {
			const due = [...this.timers.entries()]
				.filter(([, timer]) => timer.due <= target)
				.sort(([, left], [, right]) => left.due - right.due)[0];
			if (!due) break;
			const [id, timer] = due;
			this.timers.delete(id);
			this.time = timer.due;
			timer.callback();
		}
		this.time = target;
	}
}
const error = (sequence: number, generation = 1) => ({
	version: 2 as const,
	generation,
	sequence,
	source: "subagent" as const,
	state: "error" as const,
	attention: {
		reason: "failure" as const,
		occurrence: "new" as const,
	},
});
const input = (generation: number) => ({
	version: 2 as const,
	generation,
	sequence: 1,
	source: "interaction" as const,
	state: "waiting" as const,
	interaction: {
		kind: "ask_user" as const,
		pending: 1,
	},
	attention: {
		reason: "input_required" as const,
		occurrence: "new" as const,
	},
});

describe.serial("V2 actionable notification runtime", () => {
serial(
	"default policy keeps start, progress, and ordinary success quiet",
	async () =>
		withRuntime(
			{
				longRunningMs: 10,
			},
			async ({ runtime, producer, requests }) => {
				runtime.handleAgentStart({
					mode: "tui",
					sessionManager: {
						getSessionId: () => "session",
					},
				});
				const subagent = producer("subagent");
				subagent.publishState({
					version: 2,
					generation: 1,
					sequence: 1,
					source: "subagent",
					state: "running",
					progress: {
						completed: 1,
						total: 2,
					},
				});
				subagent.publishTerminal({
					version: 2,
					generation: 1,
					sequence: 2,
					source: "subagent",
					eventId: 1,
					outcome: "completed",
				});
				await sleep(120);
				expect(notices(requests)).toHaveLength(0);
			},
		),
);
serial(
	"external bursts project failure attention over blocked attention",
	async () =>
		withRuntime(
			{
				notificationPolicy: "all",
			},
			async ({ producer, requests }) => {
				const subagent = producer("subagent");
				subagent.publishState({
					version: 2,
					generation: 1,
					sequence: 1,
					source: "subagent",
					state: "running",
					attention: {
						reason: "blocked",
						occurrence: "new",
					},
				});
				subagent.publishState(error(2));
				await eventually(() => expect(attention(requests, "failure:new")).toBe(true));
				expect(notices(requests)).toHaveLength(0);
			},
		),
);
serial(
	"suppressed success transition rearms later external error",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const subagent = producer("subagent");
			subagent.publishState(error(1));
			await eventually(() => expect(attention(requests, "failure:new")).toBe(true));
			subagent.publishState({
				version: 2,
				generation: 1,
				sequence: 2,
				source: "subagent",
				state: "success",
			});
			subagent.publishState(error(3));
			await eventually(() => expect(attention(requests, "failure:new")).toBe(true));
			expect(notices(requests)).toHaveLength(0);
		}),
);
serial(
	"short input_required churn cancels every pre-dispatch toast and withdraws the final typed lifecycle",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const interaction = producer("interaction");
			for (
				let generation = 1;
				generation <= 11;
				generation += 1
			) {
				interaction.publishState(input(generation));
				interaction.withdraw({
					version: 2,
					generation,
					sequence: 2,
					source: "interaction",
				});
			}
			await sleep(120);
			expect(metas(requests).some((request) => tokens(request).v2_interaction === null && tokens(request).v2_attention === null)).toBe(true);
			expect(notices(requests)).toEqual([]);
		}),
);
serial(
	"state then terminal failure pair projects one terminal batch",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const subagent = producer("subagent");
			subagent.publishState(error(1));
			subagent.publishTerminal({
				version: 2,
				generation: 1,
				sequence: 2,
				source: "subagent",
				eventId: 1,
				outcome: "failed",
			});
			await eventually(() =>
				expect(metas(requests).some((request) => tokens(request).v2_terminals === "subagent:1:1:failed")).toBe(true),
			);
			expect(notices(requests)).toHaveLength(1);
		}),
);
serial(
	"terminal then state failure pair projects one terminal batch",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const subagent = producer("subagent");
			subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
			subagent.publishState(error(2));
			await eventually(() => expect(metas(requests).some((request) => tokens(request).v2_terminals === "subagent:1:1:failed" && tokens(request).v2_attention === "failure:new")).toBe(true));
			expect(notices(requests)).toHaveLength(1);
		}),
);
serial(
	"two distinct failed terminal event IDs each project once",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const subagent = producer("subagent");
			subagent.publishTerminal({
				version: 2,
				generation: 1,
				sequence: 1,
				source: "subagent",
				eventId: 1,
				outcome: "failed",
			});
			subagent.publishTerminal({
				version: 2,
				generation: 1,
				sequence: 2,
				source: "subagent",
				eventId: 2,
				outcome: "failed",
			});
			await eventually(() =>
				expect(metas(requests).some((request) => tokens(request).v2_terminals === "subagent:1:1:failed,subagent:1:2:failed")).toBe(true),
			);
			expect(notices(requests)).toHaveLength(2);
			expect(
				subagent.publishTerminal({
					version: 2,
					generation: 1,
					sequence: 3,
					source: "subagent",
					eventId: 2,
					outcome: "failed",
				}),
			).toBe(false);
		}),
);
serial(
	"a terminal then state failure delayed beyond input arbitration shares one notification key",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
		await eventually(() => expect(metas(requests).some((request) => tokens(request).v2_terminals === "subagent:1:1:failed")).toBe(true));
		await sleep(20);
		subagent.publishState(error(2));
		await eventually(() => expect(attention(requests, "failure:new")).toBe(true));
		await sleep(100);
		expect(notices(requests)).toHaveLength(1);
	}),
);
serial(
	"a state then terminal failure delayed beyond input arbitration shares one notification key",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishState(error(1));
		await sleep(20);
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" });
		await eventually(() => expect(metas(requests).some((request) => tokens(request).v2_terminals === "subagent:1:1:failed")).toBe(true));
		await sleep(100);
		expect(notices(requests)).toHaveLength(1);
	}),
);
serial(
	"failure representations beyond 100ms retain independent alerts",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
		await eventually(() => expect(notices(requests)).toHaveLength(1));
		await sleep(110);
		subagent.publishState(error(2));
		await eventually(() => expect(notices(requests)).toHaveLength(2));
	}),
);
serial(
	"non-adjacent failure sequences retain independent alerts",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
		await eventually(() => expect(notices(requests)).toHaveLength(1));
		subagent.publishState(error(3));
		await eventually(() => expect(notices(requests)).toHaveLength(2));
	}),
);
serial(
	"an intervening same-source event prevents failure pairing",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishState(error(1));
		await eventually(() => expect(notices(requests)).toHaveLength(1));
		subagent.publishState({ version: 2, generation: 1, sequence: 2, source: "subagent", state: "running" });
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 3, source: "subagent", eventId: 1, outcome: "failed" });
		await eventually(() => expect(notices(requests)).toHaveLength(2));
	}),
);
serial(
	"a terminal burst gives the following state the newest terminal key",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 2, outcome: "failed" });
		await eventually(() => expect(notices(requests)).toHaveLength(2));
		subagent.publishState(error(3));
		await sleep(100);
		expect(notices(requests)).toHaveLength(2);
	}),
);
serial(
	"failed terminal bursts retain the newest batch and overflow token",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		for (let eventId = 1; eventId <= 12; eventId += 1) subagent.publishTerminal({ version: 2, generation: 1, sequence: eventId, source: "subagent", eventId, outcome: "failed" });
		await eventually(() => expect(metas(requests).some((request) => tokens(request).v2_terminal_overflow === "9")).toBe(true));
		await sleep(40);
		expect(notices(requests).length).toBeGreaterThan(0);
		expect(notices(requests).length).toBeLessThanOrEqual(9);
	}),
);
serial(
	"long-running time pauses for native input and resumes with a silent notification",
	async () => {
		const clock = new ManualLongRunningScheduler();
		await withRuntime({ notificationPolicy: "background", longRunningMs: 30 }, async ({ runtime, requests }) => {
			const context = (runtime as unknown as { context: object }).context;
			runtime.handleAgentStart(context);
			clock.advance(10);
			runtime.handleUiPromptStart(context);
			clock.advance(100);
			expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(0);
			runtime.handleUiPromptEnd(context);
			clock.advance(19);
			expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(0);
			clock.advance(1);
			await eventually(() => expect(notices(requests).filter(request => request.params?.title === "Pi is still working").map(request => request.params)).toEqual([
				{ title: "Pi is still working", body: "A Pi task is taking longer than expected", sound: "none" },
			]));
		}, clock);
	},
);
serial(
	"long-running time pauses for V2 blocked and failure state and does not double-resume overlapping input",
	async () => {
		const clock = new ManualLongRunningScheduler();
		await withRuntime({ notificationPolicy: "background", longRunningMs: 30 }, async ({ runtime, producer, requests }) => {
			const context = (runtime as unknown as { context: object }).context;
			const subagent = producer("subagent");
			const interaction = producer("interaction");
			runtime.handleAgentStart(context);
			clock.advance(5);
			subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } });
			clock.advance(50);
			subagent.publishState({ version: 2, generation: 1, sequence: 2, source: "subagent", state: "running" });
			clock.advance(5);
			subagent.publishState(error(3));
			clock.advance(50);
			subagent.publishState({ version: 2, generation: 1, sequence: 4, source: "subagent", state: "running" });
			runtime.handleUiPromptStart(context);
			interaction.publishState(input(1));
			runtime.handleUiPromptEnd(context);
			clock.advance(100);
			expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(0);
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			clock.advance(20);
			await eventually(() => expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(1));
		}, clock);
	},
);
serial(
	"elapsed work held behind a blocked callback fires only after working resumes",
	async () => {
		const clock = new ManualLongRunningScheduler();
		await withRuntime({ notificationPolicy: "background", longRunningMs: 20 }, async ({ runtime, requests }) => {
			const context = (runtime as unknown as { context: object }).context;
			runtime.handleAgentStart(context);
			clock.elapse(20);
			runtime.handleUiPromptStart(context);
			expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(0);
			runtime.handleUiPromptEnd(context);
			await eventually(() => expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(1));
		}, clock);
	},
);
serial(
	"retained blocked reload starts the long-running budget only after composite working resumes",
	async () => {
		const clock = new ManualLongRunningScheduler();
		const sessionManager = { getSessionId: () => "reload" };
		let subagent!: PresenceProducerHandle;
		await withRuntime(
			{ notificationPolicy: "background", longRunningMs: 20 },
			async ({ requests }) => {
				clock.advance(100);
				expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(0);
				subagent.publishState({ version: 2, generation: 1, sequence: 2, source: "subagent", state: "running" });
				clock.advance(20);
				await eventually(() => expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(1));
			},
			clock,
			({ producer }) => {
				subagent = producer("subagent");
				subagent.publishState({ version: 2, generation: 1, sequence: 1, source: "subagent", state: "waiting", attention: { reason: "blocked", occurrence: "new" } });
			},
			{ mode: "tui", isIdle: () => false, sessionManager },
		);
	},
);
serial(
	"agent end, settlement, replacement, and shutdown clear long-running state",
	async () => {
		const clock = new ManualLongRunningScheduler();
		await withRuntime({ notificationPolicy: "background", longRunningMs: 20 }, async ({ runtime, requests }) => {
			const internal = runtime as unknown as { context: object; longRunningRemaining: number | null; longRunningTimer: unknown };
			const context = internal.context;
			runtime.handleAgentStart(context);
			runtime.handleAgentEnd({}, context);
			expect(internal.longRunningRemaining).toBeNull();
			runtime.handleAgentSettled({ ...(context as object), isIdle: () => true });
			runtime.handleAgentStart(context);
			await runtime.startSession({ mode: "tui", sessionManager: { getSessionId: () => "replacement" } });
			expect(internal.longRunningRemaining).toBeNull();
			const replacement = internal.context;
			runtime.handleAgentStart(replacement);
			await runtime.shutdownSession(replacement);
			expect(internal.longRunningRemaining).toBeNull();
			clock.advance(100);
			await sleep();
			expect(notices(requests).filter(request => request.params?.title === "Pi is still working")).toHaveLength(0);
		}, clock);
	},
);

});
