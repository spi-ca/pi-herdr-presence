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
import { PresenceRuntime } from "../src/runtime.js";
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
	);
	try {
		Object.assign(process.env, {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: socketPath,
			HERDR_PANE_ID: "pane",
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
		await runtime.startSession({
			mode: "tui",
			sessionManager: {
				getSessionId: () => "session",
			},
		});
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
	"input_required churn is rate-bounded and withdraws the final typed lifecycle",
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
			expect(notices(requests).length).toBeGreaterThan(0);
			expect(notices(requests).length).toBeLessThanOrEqual(9);
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
	"a delayed same-generation failure state retains typed attention after the pairing window",
	async () => withRuntime({}, async ({ producer, requests }) => {
		const subagent = producer("subagent");
		subagent.publishTerminal({ version: 2, generation: 1, sequence: 1, source: "subagent", eventId: 1, outcome: "failed" });
		await eventually(() => expect(metas(requests).some((request) => tokens(request).v2_terminals === "subagent:1:1:failed")).toBe(true));
		await sleep(20);
		subagent.publishState(error(2));
		await eventually(() => expect(attention(requests, "failure:new")).toBe(true));
		expect(notices(requests)).toHaveLength(1);
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

});
