import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
	EVENT_NAMES,
	MAX_INTEGER,
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
type H = {
	runtime: PresenceRuntime;
	requests: Request[];
	producer(source: PresenceSource): PresenceProducerHandle;
};
const keys = [
	"HERDR_ENV",
	"HERDR_SOCKET_PATH",
	"HERDR_PANE_ID",
	"HERDR_WORKSPACE_ID",
	"PI_CODING_AGENT_DIR",
] as const;
const sleep = (ms = 20) =>
	new Promise<void>((done) => setTimeout(done, ms));
let previous = Promise.resolve();
function serial(name: string, run: () => Promise<void>) {
	let release!: () => void;
	const mine = new Promise<void>((done) => {
		release = done;
	});
	const prior = previous;
	previous = mine;
	test(name, async () => {
		await prior;
		try {
			await run();
		} finally {
			release();
		}
	});
}
async function eventually(assertion: () => void) {
	let error: unknown;
	for (let i = 0; i < 50; i += 1) {
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
function bus() {
	const listeners = new Map<
		string,
		Array<(value: unknown) => void>
	>();
	return {
		on(name: string, listener: (value: unknown) => void) {
			listeners.set(name, [
				...(listeners.get(name) ?? []),
				listener,
			]);
		},
		emit(name: string, value: unknown) {
			for (const listener of listeners.get(name) ?? [])
				listener(value);
		},
	};
}
async function withRuntime(
	config: Partial<ReturnType<typeof resolvePresenceConfig>>,
	run: (h: H) => Promise<void>,
	before?: (h: H) => void,
) {
	const dir = await fs.mkdtemp(
		join(os.tmpdir(), "herdr-v2-input-"),
	);
	const socket = join(dir, "socket");
	const requests: Request[] = [];
	const server = await fakeSocket(socket, (line) => {
		const request = JSON.parse(line) as Request;
		requests.push(request);
		return JSON.stringify({
			id: request.id,
			result: {},
		});
	});
	const saved = Object.fromEntries(
		keys.map((key) => [
			key,
			process.env[key],
		]),
	);
	const events = bus();
	const producers: PresenceProducerHandle[] = [];
	let runtime: PresenceRuntime | undefined;
	try {
		Object.assign(process.env, {
			HERDR_ENV: "1",
			HERDR_SOCKET_PATH: socket,
			HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace",
			PI_CODING_AGENT_DIR: join(dir, "absent"),
		});
		runtime = new PresenceRuntime(
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
		const currentRuntime = runtime;
		for (const name of [
			EVENT_NAMES.state,
			EVENT_NAMES.terminal,
			EVENT_NAMES.withdraw,
		])
			events.on(name, (payload) =>
				currentRuntime.handlePresenceEvent(name, payload),
			);
		const h: H = {
			runtime: currentRuntime,
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
		before?.(h);
		await runtime.startSession({
			mode: "tui",
			sessionManager: {
				getSessionId: () => "session",
			},
		});
		await run(h);
	} finally {
		try {
			if (runtime) await runtime.shutdownSession((runtime as unknown as { context: object }).context);
		} finally {
			for (const producer of producers) producer.deactivate();
		}
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await server.close();
		await fs.rm(dir, {
			recursive: true,
			force: true,
		});
	}
}
const notices = (requests: Request[]) =>
	requests.filter(
		(request) => request.method === "notification.show",
	);
const tokens = (request: Request) =>
	request.params?.tokens as Record<string, string | null>;
const reports = (requests: Request[]) =>
	requests.filter(
		(request) => request.method === "pane.report_agent",
	);
const metas = (requests: Request[]) =>
	requests.filter(
		(request) => request.method === "pane.report_metadata",
	);
const input = (sequence: number, generation = 1) => ({
	version: 2 as const,
	generation,
	sequence,
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
const failure = (sequence: number, generation = 1) => ({
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

describe.serial("V2 interaction runtime", () => {
serial(
	"interaction waiting is blocked, private, and projects typed attention",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			expect(
				producer("interaction").publishState(input(1)),
			).toBe(true);
			await eventually(() =>
				expect(reports(requests).at(-1)?.params).toMatchObject({
					state: "blocked",
					message: "Pi needs your input",
				}),
			);
			expect(metas(requests).some((request) => tokens(request).v2_attention === "input_required:new" && tokens(request).v2_interaction === "ask_user:1")).toBe(true);
			expect(notices(requests)).toHaveLength(1);
			expect(JSON.stringify(requests)).not.toContain(
				"private",
			);
		}),
);
serial("retained interaction is quiet", async () =>
	withRuntime(
		{
			notificationPolicy: "all",
		},
		async ({ requests }) => {
			await eventually(() =>
				expect(
					reports(requests).at(-1)?.params,
				).toMatchObject({
					state: "blocked",
				}),
			);
			expect(notices(requests)).toHaveLength(0);
		},
		({ producer }) => {
			producer("interaction").publishState(input(1));
		},
	),
);
serial(
	"notification policy and kill switch preserve typed input projection",
	async () => {
		const projections: Array<Record<string, string | null>> = [];
		for (const config of [{ notificationPolicy: "all" as const }, { notificationPolicy: "disabled" as const }, { notifications: false }]) {
			await withRuntime(config, async ({ producer, requests }) => {
				producer("interaction").publishState(input(1));
				await eventually(() => expect(metas(requests).some((request) => tokens(request).v2_interaction === "ask_user:1")).toBe(true));
				projections.push(metas(requests).map(tokens).find((value) => value.v2_interaction === "ask_user:1")!);
				expect(notices(requests)).toHaveLength(config.notificationPolicy === "all" ? 1 : 0);
			});
		}
		expect(projections[0]).toEqual(projections[1]);
		expect(projections[1]).toEqual(projections[2]);
	},
);
serial("higher sequence preserves one typed interaction projection", async () =>
	withRuntime({}, async ({ producer, requests }) => {
		const p = producer("interaction");
		p.publishState(input(1));
		p.publishState(input(2));
		await eventually(() =>
			expect(metas(requests).some((request) => tokens(request).v2_interaction === "ask_user:1")).toBe(true),
		);
		expect(notices(requests)).toHaveLength(1);
	}),
);
serial(
	"withdrawal and new generation re-enter typed input lifecycle",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const p = producer("interaction");
			p.publishState(input(1));
			await eventually(() =>
				expect(metas(requests).some((request) => tokens(request).v2_interaction === "ask_user:1")).toBe(true),
			);
			p.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			p.publishState(input(1, 2));
			await eventually(() =>
				expect(metas(requests).filter((request) => tokens(request).v2_interaction === "ask_user:1").length).toBeGreaterThan(1),
			);
			expect(notices(requests)).toHaveLength(2);
		}),
);
serial(
	"input_required takes precedence over retained failure",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const i = producer("interaction");
			const s = producer("subagent");
			i.publishState(input(1));
			await eventually(() =>
				expect(metas(requests).some((request) => tokens(request).v2_interaction === "ask_user:1")).toBe(true),
			);
			s.publishState(failure(1));
			await sleep(80);
			// A failure accepted during this admitted aggregate input lifecycle is
			// attached to it and therefore does not create a competing alert.
			expect(notices(requests)).toHaveLength(1);
			expect(
				reports(requests).at(-1)?.params,
			).toMatchObject({
				message: "Pi needs your input",
			});
			s.withdraw({
				version: 2,
				generation: 1,
				sequence: 2,
				source: "subagent",
			});
			await eventually(() =>
				expect(
					reports(requests).at(-1)?.params,
				).toMatchObject({
					message: "Pi needs your input",
				}),
			);
		}),
);
serial(
	"native failure then input then end retains the admitted input arbitration",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const context = (runtime as unknown as { context: object }).context;
			producer("subagent").publishState(failure(1));
			runtime.handleUiPromptStart(context);
			runtime.handleUiPromptEnd(context);
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]));
			await sleep(30);
			expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]);
			expect((runtime as unknown as { failureArrivals: unknown[] }).failureArrivals).toEqual([]);
			expect("inputNotificationTimer" in (runtime as object)).toBe(false);
		}),
);
serial(
	"native input then failure then end retains the admitted input arbitration",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const context = (runtime as unknown as { context: object }).context;
			runtime.handleUiPromptStart(context);
			producer("subagent").publishState(failure(1));
			runtime.handleUiPromptEnd(context);
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]));
		}),
);
serial(
	"V2 failure then input then withdrawal retains the admitted input arbitration",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const interaction = producer("interaction");
			producer("subagent").publishState(failure(1));
			interaction.publishState(input(1));
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]));
			await sleep(30);
			expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]);
		}),
);
serial(
	"V2 input then failure then withdrawal retains the admitted input arbitration",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const interaction = producer("interaction");
			interaction.publishState(input(1));
			producer("subagent").publishState(failure(1));
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]));
			await sleep(30);
			expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]);
		}),
);
serial(
	"an input-suppressed failure leaves its delayed failed terminal independently eligible",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const interaction = producer("interaction");
			const subagent = producer("subagent");
			interaction.publishState(input(1));
			subagent.publishState(failure(1));
			await sleep(20);
			subagent.publishTerminal({ version: 2, generation: 1, sequence: 2, source: "subagent", eventId: 1, outcome: "failed" });
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input", "Pi needs attention"]));
		}),
);
serial(
	"a retained failure already notified before a native prompt keeps its separate input alert",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			producer("subagent").publishState(failure(1));
			await eventually(() => expect(notices(requests)).toHaveLength(1));
			runtime.handleUiPromptStart((runtime as unknown as { context: object }).context);
			await sleep(100);
			expect(notices(requests).map((request) => request.params?.title)).toEqual([
				"Pi needs attention",
				"Pi needs your input",
			]);
		}),
);
serial(
	"failure withdrawal cannot cancel the nearby native input alert",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const subagent = producer("subagent");
			subagent.publishState(failure(1));
			runtime.handleUiPromptStart((runtime as unknown as { context: object }).context);
			subagent.withdraw({ version: 2, generation: 1, sequence: 2, source: "subagent" });
			await sleep(100);
			expect(notices(requests).map((request) => request.params?.title)).toEqual([
				"Pi needs your input",
			]);
		}),
);
serial(
	"rate-rejected input leaves a nearby failure eligible",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const rate = (runtime as unknown as { notificationRate: { accept(kind: "input" | "other"): boolean } }).notificationRate;
			expect(rate.accept("input")).toBe(true);
			for (let index = 0; index < 8; index += 1) expect(rate.accept("other")).toBe(true);
			const interaction = producer("interaction");
			interaction.publishState(input(1));
			producer("subagent").publishState(failure(1));
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs attention"]));
		}),
);
serial(
	"a rejected new input lifecycle cannot inherit the previous admission tombstone",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const interaction = producer("interaction");
			interaction.publishState(input(1));
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input"]));
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			const rate = (runtime as unknown as { notificationRate: { accept(kind: "other"): boolean } }).notificationRate;
			for (let index = 0; index < 8; index += 1) expect(rate.accept("other")).toBe(true);
			interaction.publishState(input(1, 2));
			producer("subagent").publishState(failure(1));
			interaction.withdraw({ version: 2, generation: 2, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input", "Pi needs attention"]));
			await sleep(30);
			expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input", "Pi needs attention"]);
			expect((runtime as unknown as { failureArrivals: unknown[] }).failureArrivals).toEqual([]);
		}),
);
serial(
	"a queued failure remains bound to admitted A while rejected B owns its own failure",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const interaction = producer("interaction");
			const subagent = producer("subagent");
			// This failure arrives first, then is claimed by A when A begins.
			subagent.publishState(failure(1));
			interaction.publishState(input(1));
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			const rate = (runtime as unknown as { notificationRate: { accept(kind: "other"): boolean } }).notificationRate;
			for (let index = 0; index < 8; index += 1) expect(rate.accept("other")).toBe(true);
			// B is rejected. Its failure must bind to B, not inherit A's receipt.
			interaction.publishState(input(1, 2));
			subagent.publishState(failure(1, 2));
			interaction.withdraw({ version: 2, generation: 2, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input", "Pi needs attention"]));
			await sleep(30);
			expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs your input", "Pi needs attention"]);
			expect((runtime as unknown as { failureArrivals: unknown[] }).failureArrivals).toEqual([]);
		}),
);
serial(
	"input rejected by notify admission leaves a nearby failure eligible",
	async () =>
		withRuntime({}, async ({ runtime, producer, requests }) => {
			const internal = runtime as unknown as {
				notify(severity: string, key: string, title: string, body: string, origin: "local" | "external"): boolean;
			};
			const notify = internal.notify.bind(runtime);
			internal.notify = (severity, key, title, body, origin) => severity === "attention" ? false : notify(severity, key, title, body, origin);
			const interaction = producer("interaction");
			interaction.publishState(input(1));
			producer("subagent").publishState(failure(1));
			interaction.withdraw({ version: 2, generation: 1, sequence: 2, source: "interaction" });
			await eventually(() => expect(notices(requests).map((request) => request.params?.title)).toEqual(["Pi needs attention"]));
		}),
);
serial(
	"notification acceptance timestamps remain monotonic beyond the wire integer bound",
	async () => {
		let now = MAX_INTEGER + 1;
		const runtime = new PresenceRuntime({ getAllTools: () => [], events: bus() } as never, { ...resolvePresenceConfig(), soleReporter: true }, undefined, () => now);
		const internal = runtime as unknown as { nextNotificationAcceptanceTime(): number };
		expect(internal.nextNotificationAcceptanceTime()).toBe(MAX_INTEGER + 1);
		now += MAX_INTEGER + 1;
		expect(internal.nextNotificationAcceptanceTime()).toBe((MAX_INTEGER + 1) * 2);
	},
);
serial(
	"metadata emits ten interaction and attention tokens",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				const i = producer("interaction");
				const s = producer("subagent");
				i.publishState(input(1));
				s.publishState({
					version: 2,
					generation: 1,
					sequence: 1,
					source: "subagent",
					state: "running",
					progress: {
						completed: 2,
						total: 5,
					},
					subagents: {
						running: 1,
						cancelling: 2,
						queued: 3,
						completed: 4,
						failed: 5,
						cancelled: 6,
						omitted: 7,
					},
				});
				s.publishTerminal({
					version: 2,
					generation: 1,
					sequence: 2,
					source: "subagent",
					eventId: 9,
					outcome: "completed",
				});
				await eventually(() =>
					expect(
						metas(requests).some(
							(r) =>
								(r.params?.tokens as Record<string, string>)
									?.v2_terminals ===
								"subagent:1:9:completed",
						),
					).toBe(true),
				);
				const t = metas(requests)
					.map(
						(r) =>
							r.params?.tokens as Record<string, string>,
					)
					.find((v) => v.v2_terminals);
				expect(t).toBeDefined();
				expect(Object.keys(t!)).toEqual([
					"summary",
					"v2_progress",
					"v2_attention",
					"v2_interaction",
					"v2_subagents",
					"v2_terminals",
					"v2_terminal_overflow",
					"tokens",
					"cost",
					"context",
				]);
				expect(t).toMatchObject({
					v2_progress: "2/5",
					v2_attention: "input_required:new",
					v2_interaction: "ask_user:1",
					v2_subagents: "1,2,3,4,5,6,7",
				});
			},
		),
);

});
