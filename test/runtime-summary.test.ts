import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import {
	EVENT_NAMES,
	MAX_INTEGER,
	createPresenceProducer,
	parseTerminalBatch,
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
type SessionContext = { mode: "tui"; sessionManager: { getSessionId: () => string }; isIdle: () => boolean; getContextUsage?: () => unknown };
type Harness = {
	runtime: PresenceRuntime;
	context: SessionContext;
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
	body: (h: Harness) => Promise<void>,
) {
	const dir = await fs.mkdtemp(
		join(os.tmpdir(), "herdr-v2-summary-"),
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
			HERDR_SOCKET_PATH: socket,
			HERDR_PANE_ID: "pane", HERDR_WORKSPACE_ID: "workspace",
			PI_CODING_AGENT_DIR: join(dir, "absent"),
		});
		for (const name of [
			EVENT_NAMES.state,
			EVENT_NAMES.terminal,
			EVENT_NAMES.withdraw,
		])
			events.on(name, (payload) =>
				runtime.handlePresenceEvent(name, payload),
			);
		const context: SessionContext = {
			mode: "tui",
			sessionManager: { getSessionId: () => "session" },
			isIdle: () => true,
		};
		const h: Harness = {
			runtime,
			context,
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
		await runtime.startSession(context);
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
			await fs.rm(dir, {
				recursive: true,
				force: true,
			});
		}
	}
}
const metas = (requests: Request[]) =>
	requests.filter(
		(request) => request.method === "pane.report_metadata",
	);
const token = (request: Request) =>
	request.params?.tokens as Record<string, string | null>;
const terminal = (
	eventId: number,
	sequence: number,
	outcome:
		| "completed"
		| "failed"
		| "cancelled" = "completed",
	generation = 1,
) => ({
	version: 2 as const,
	generation,
	sequence,
	source: "subagent" as const,
	eventId,
	outcome,
});
const aggregate = (
	sequence: number,
	progress?: {
		completed: number;
		total: number;
	},
) => ({
	version: 2 as const,
	generation: 1,
	sequence,
	source: "subagent" as const,
	state: "running" as const,
	...(progress
		? {
				progress,
			}
		: {}),
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
function terminalMetadata(
	requests: Request[],
	value: string,
) {
	return metas(requests).some(
		(request) => token(request).v2_terminals === value,
	);
}

describe.serial("V2 terminal and aggregate runtime", () => {
serial(
	"recent terminal batch retains three canonical records and overflow",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				const p = producer("subagent");
				p.publishTerminal(terminal(1, 1));
				p.publishTerminal(terminal(2, 2, "failed"));
				p.publishTerminal(terminal(3, 3));
				p.publishTerminal(terminal(4, 4, "cancelled"));
				await eventually(() =>
					expect(
						terminalMetadata(
							requests,
							"subagent:1:2:failed,subagent:1:3:completed,subagent:1:4:cancelled",
						),
					).toBe(true),
				);
				expect(
					metas(requests)
						.map(token)
						.some(
							(value) => value.v2_terminal_overflow === "1",
						),
				).toBe(true);
			},
		),
);
serial(
	"max-generation and event terminal values retain the newest canonical records within Herdr's 80-byte limit",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				const p = producer("subagent");
				p.publishTerminal(terminal(MAX_INTEGER - 2, 1, "cancelled", MAX_INTEGER));
				p.publishTerminal(terminal(MAX_INTEGER - 1, 2, "cancelled", MAX_INTEGER));
				p.publishTerminal(terminal(MAX_INTEGER, 3, "cancelled", MAX_INTEGER));
				const expected = `subagent:${MAX_INTEGER}:${MAX_INTEGER - 1}:cancelled,subagent:${MAX_INTEGER}:${MAX_INTEGER}:cancelled`;
				await eventually(() =>
					expect(terminalMetadata(requests, expected)).toBe(true),
				);
				const tokens = metas(requests).map(token).find(value => value.v2_terminals === expected)!;
				const terminalValue = tokens.v2_terminals;
				expect(terminalValue).toBe(expected);
				if (terminalValue === null) throw new Error("expected terminal value");
				expect(Buffer.byteLength(terminalValue, "utf8")).toBeLessThanOrEqual(80);
				expect(tokens.v2_terminal_overflow).toBe("1");
				expect(parseTerminalBatch(terminalValue, Number(tokens.v2_terminal_overflow))?.value).toBe(terminalValue);
			},
		),
);
serial(
	"terminal identities remain silent across owner replacement while a distinct terminal renders once",
	async () =>
		withRuntime({}, async ({ producer, requests }) => {
			const first = producer("subagent");
			first.publishTerminal(terminal(1, 1));
			await eventually(() =>
				expect(terminalMetadata(requests, "subagent:1:1:completed")).toBe(true),
			);
			const metadataCount = metas(requests).length;
			first.deactivate();

			const identical = producer("subagent");
			identical.publishTerminal(terminal(1, 1));
			await sleep(40);
			expect(metas(requests)).toHaveLength(metadataCount);
			expect(requests.filter((request) => request.method === "notification.show")).toHaveLength(0);
			identical.deactivate();

			const conflict = producer("subagent");
			conflict.publishTerminal(terminal(1, 1, "failed"));
			await sleep(40);
			expect(metas(requests)).toHaveLength(metadataCount);
			expect(requests.filter((request) => request.method === "notification.show")).toHaveLength(0);

			conflict.publishTerminal(terminal(2, 2, "failed"));
			await eventually(() =>
				expect(
					terminalMetadata(
						requests,
						"subagent:1:1:completed,subagent:1:2:failed",
					),
				).toBe(true),
			);
			expect(requests.filter((request) => request.method === "notification.show")).toHaveLength(1);
		}),
);
serial(
	"state immediately after terminal preserves batch through LWW metadata",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				const p = producer("subagent");
				p.publishTerminal(terminal(7, 1));
				p.publishState(aggregate(2));
				await eventually(() =>
					expect(
						terminalMetadata(
							requests,
							"subagent:1:7:completed",
						),
					).toBe(true),
				);
			},
		),
);
serial(
	"terminal expiry clears metadata once without repeating the pane agent report",
	async () =>
		withRuntime(
			{
				finalClearMs: 80,
				notificationPolicy: "disabled",
			},
			async ({ runtime, context, requests }) => {
				runtime.handleAgentStart(context);
				runtime.handleAgentEnd(
					{
						messages: [
							{
								stopReason: "stop",
							},
						],
					},
					context,
				);
				runtime.handleAgentSettled(context);
				await eventually(() =>
					expect(
						metas(requests)
							.map(token)
							.some(
								(value) =>
									value.v2_terminals?.startsWith("pi:") ===
									true,
							),
					).toBe(true),
				);
				const terminalMetadataCount = metas(requests).length;
				const agentReportCount = requests.filter(
					(request) => request.method === "pane.report_agent",
				).length;
				await eventually(() =>
					expect(metas(requests).length).toBe(terminalMetadataCount + 1),
				);
				const expiryMetadata = metas(requests).at(-1);
				expect(token(expiryMetadata!).v2_terminals).toBeNull();
				expect(token(expiryMetadata!).v2_terminal_overflow).toBeNull();
				expect(token(expiryMetadata!).summary).toBe("idle");
				expect(
					requests.filter((request) => request.method === "pane.report_agent"),
				).toHaveLength(agentReportCount);
				await sleep(120);
				expect(metas(requests)).toHaveLength(terminalMetadataCount + 1);
			},
		),
);
serial(
	"withdrawal clears aggregate while retaining terminal history",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				const p = producer("subagent");
				p.publishState(aggregate(1));
				p.publishTerminal(terminal(1, 2));
				await eventually(() =>
					expect(
						metas(requests)
							.map(token)
							.some(
								(value) =>
									value.v2_subagents === "1,2,3,4,5,6,7",
							),
					).toBe(true),
				);
				p.withdraw({
					version: 2,
					generation: 1,
					sequence: 3,
					source: "subagent",
				});
				await eventually(() =>
					expect(
						metas(requests)
							.map(token)
							.some(
								(value) =>
									value.v2_subagents === null &&
									value.v2_terminals ===
										"subagent:1:1:completed",
							),
					).toBe(true),
				);
			},
		),
);
serial(
	"subagent aggregate emits all seven counts",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				producer("subagent").publishState(aggregate(1));
				await eventually(() =>
					expect(
						metas(requests)
							.map(token)
							.some(
								(value) =>
									value.v2_subagents === "1,2,3,4,5,6,7",
							),
					).toBe(true),
				);
			},
		),
);
serial(
	"progress token emits completed over total",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				producer("subagent").publishState(
					aggregate(1, {
						completed: 4,
						total: 9,
					}),
				);
				await eventually(() =>
					expect(
						metas(requests)
							.map(token)
							.some((value) => value.v2_progress === "4/9"),
					).toBe(true),
				);
			},
		),
);
serial(
	"usage, cost, and context tokens use runtime usage hooks",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ runtime, context, requests }) => {
				context.getContextUsage = () => ({ percent: 42.5 });
				runtime.handleAgentStart(context);
				runtime.handleMessageEnd(
					{
						message: {
							role: "assistant",
							usage: {
								input: 11,
								output: 7,
								cacheRead: 2,
								cost: {
									total: 1.25,
								},
							},
						},
					},
					context,
				);
				await eventually(() =>
					expect(
						metas(requests)
							.map(token)
							.some(
								(value) =>
									value.tokens === "20" &&
									value.cost === "1.25" &&
									value.context === "42.5",
							),
					).toBe(true),
				);
			},
		),
);
serial(
	"empty terminal batch emits null, never empty string",
	async () =>
		withRuntime(
			{
				notificationPolicy: "disabled",
			},
			async ({ producer, requests }) => {
				producer("subagent").publishState(aggregate(1));
				await eventually(() =>
					expect(metas(requests).length).toBeGreaterThan(0),
				);
				const values = metas(requests).map(token);
				expect(
					values.some((value) => value.v2_terminals === ""),
				).toBe(false);
				expect(
					values.some(
						(value) => value.v2_terminals === null,
					),
				).toBe(true);
			},
		),
);

});
