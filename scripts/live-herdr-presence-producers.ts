/*
 * Manual V2 producer smoke harness (not part of bun test).
 * Requires a real Herdr socket and sibling pi-ask-user/pi-subagent checkouts.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import net from "node:net";
import * as os from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePresenceConfig, resolvePresenceMode } from "../src/config.js";
import { registerPresenceHooks } from "../src/hooks.js";
import { readHerdrIdentity, safeSocketFingerprint } from "../src/identity.js";
import { officialHookStatus } from "../src/official-hook.js";
import {
	HERDR_LEGACY_METADATA_TOKEN_KEYS,
	HERDR_METADATA_TOKEN_KEYS,
	isExactAgentAuthorityClearParams,
	isExactLegacyMetadataClearParams,
	isExactMetadataClearParams,
	isExactMetadataIngressParams,
} from "../src/protocol.js";
import { PresenceRuntime } from "../src/runtime.js";

const LIVE_SMOKE_OPT_IN = "disposable-standalone-pane";
/** The smoke needs enough retained terminal time to observe and withdraw it reliably. */
const MINIMUM_TERMINAL_RETENTION_MS = 1_000;
const RELAY_TIMEOUT_MS = 3_000;
const MAX_RELAY_RESPONSE_BYTES = 16 * 1024;

function rejectUnsafeRun(message: string): never {
	throw new Error(`Live smoke refused: ${message}`);
}

if (process.env.PI_HERDR_LIVE_SMOKE !== LIVE_SMOKE_OPT_IN) {
	rejectUnsafeRun(
		`set PI_HERDR_LIVE_SMOKE=${LIVE_SMOKE_OPT_IN} to run against a disposable standalone pane`,
	);
}

// Reject unsafe local settings before constructing a runtime/proxy or touching a socket.
const config = resolvePresenceConfig();
if (!config.metadata) rejectUnsafeRun("requires PI_HERDR_PRESENCE_METADATA to be enabled");
if (config.notifications && config.notificationPolicy !== "disabled") {
	rejectUnsafeRun(
		"requires PI_HERDR_PRESENCE_NOTIFICATIONS=false or PI_HERDR_PRESENCE_NOTIFY_POLICY=disabled",
	);
}
if (config.finalClearMs < MINIMUM_TERMINAL_RETENTION_MS) {
	rejectUnsafeRun(
		`requires PI_HERDR_PRESENCE_FINAL_CLEAR_MS >= ${MINIMUM_TERMINAL_RETENTION_MS}ms for reliable terminal observation`,
	);
}

const identity = readHerdrIdentity();
if (!identity) {
	rejectUnsafeRun(
		"requires HERDR_ENV=1, an absolute HERDR_SOCKET_PATH, HERDR_WORKSPACE_ID, and HERDR_PANE_ID",
	);
}

const managedHook = await officialHookStatus();
if (managedHook !== "absent") {
	rejectUnsafeRun("requires exact standalone managed-hook absence");
}

if (resolvePresenceMode(config, managedHook) !== "standalone") {
	rejectUnsafeRun(
		"current presence configuration does not select standalone mode",
	);
}

await safeSocketFingerprint(identity.socketPath);

const realSocketPath = identity.socketPath;
const askUserRoot =
	process.env.PI_ASK_USER_ROOT ??
	new URL("../../pi-ask-user/", import.meta.url).pathname;
const subagentRoot =
	process.env.PI_SUBAGENT_ROOT ??
	new URL("../../pi-subagent/", import.meta.url).pathname;
const { AskUserPresence } = await import(
	pathToFileURL(`${askUserRoot.replace(/\/$/, "")}/src/presence.ts`).href
);
const { PiSubagentPresenceProducer } = await import(
	pathToFileURL(
		`${subagentRoot.replace(/\/$/, "")}/src/integration/pi-presence-producer.ts`,
	).href
);

type Listener = (payload: unknown) => void;
type CapturedRequest = {
	id: string;
	method: string;
	params: Record<string, unknown>;
};
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
	Object.keys(value).length === keys.length &&
	keys.every((key, index) => Object.keys(value)[index] === key);
const isExactSessionReport = (params: Record<string, unknown>) =>
	exactKeys(params, [
		"pane_id",
		"source",
		"agent",
		"seq",
		"agent_session_id",
	]) &&
	params.pane_id === identity.paneId &&
	params.source === "herdr:pi" &&
	params.agent === "pi" &&
	Number.isSafeInteger(params.seq) &&
	params.agent_session_id === sessionId;
const isExactAgentReport = (params: Record<string, unknown>) =>
	exactKeys(params, [
		"pane_id",
		"source",
		"agent",
		"state",
		"message",
		"seq",
		"agent_session_id",
	]) &&
	params.pane_id === identity.paneId &&
	params.source === "herdr:pi" &&
	params.agent === "pi" &&
	params.state === "idle" &&
	params.message === "Pi is idle" &&
	Number.isSafeInteger(params.seq) &&
	params.agent_session_id === sessionId;
const isExactAgentAuthorityClear = (params: Record<string, unknown>) =>
	isExactAgentAuthorityClearParams(params) &&
	exactKeys(params, ["pane_id", "source", "seq"]) &&
	params.pane_id === identity.paneId &&
	params.source === "herdr:pi" &&
	Number.isSafeInteger(params.seq);
type Proxy = {
	socketPath: string;
	captured: CapturedRequest[];
	acknowledged: CapturedRequest[];
	waitFor(
		predicate: (request: CapturedRequest) => boolean,
		acknowledged?: boolean,
	): Promise<CapturedRequest>;
	close(): Promise<void>;
};

/** Event-driven, owner-only relay: every runtime RPC is observed and receives Herdr's real response. */
async function createProxy(realPath: string): Promise<Proxy> {
	const directory = await fs.mkdtemp(
		join(os.tmpdir(), "pi-herdr-presence-proxy-"),
	);
	await fs.chmod(directory, 0o700);
	const socketPath = join(directory, "socket");
	const captured: CapturedRequest[] = [];
	const acknowledged: CapturedRequest[] = [];
	const activeUpstreams = new Set<net.Socket>();
	const activeDownstreams = new Set<net.Socket>();
	const waiters: Array<{
		predicate: (request: CapturedRequest) => boolean;
		acknowledged: boolean;
		resolve: (request: CapturedRequest) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}> = [];
	const notify = (request: CapturedRequest, ack: boolean) => {
		for (const waiter of [...waiters]) {
			if (waiter.acknowledged !== ack || !waiter.predicate(request)) continue;
			clearTimeout(waiter.timer);
			waiters.splice(waiters.indexOf(waiter), 1);
			waiter.resolve(request);
		}
	};
	const waitFor = (
		predicate: (request: CapturedRequest) => boolean,
		ack = false,
	) => {
		const prior = (ack ? acknowledged : captured).find(predicate);
		if (prior) return Promise.resolve(prior);
		return new Promise<CapturedRequest>((resolve, reject) => {
			const waiter = {
				predicate,
				acknowledged: ack,
				resolve,
				reject,
				timer: undefined as unknown as ReturnType<typeof setTimeout>,
			};
			waiter.timer = setTimeout(() => {
				const index = waiters.indexOf(waiter);
				if (index >= 0) waiters.splice(index, 1);
				reject(
					new Error(
						`timed out waiting for ${ack ? "acknowledged " : "captured "}Herdr output`,
					),
				);
			}, RELAY_TIMEOUT_MS);
			waiters.push(waiter);
		});
	};
	const relay = (line: string, downstream: net.Socket) =>
		new Promise<string>((resolve, reject) => {
			let upstream: net.Socket | undefined;
			let response = "";
			let done = false;
			let postConnectValidated = false;
			let writeDispatched = false;
			const timer = setTimeout(
				() => finish(new Error("timed out relaying Herdr response")),
				RELAY_TIMEOUT_MS,
			);
			const finish = (error?: Error, value?: string) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				upstream?.destroy();
				error ? reject(error) : resolve(value ?? "");
			};
			const downstreamClosed = () =>
				finish(new Error("runtime connection closed during relay"));
			downstream.once("error", downstreamClosed);
			downstream.once("close", downstreamClosed);
			void (async () => {
				try {
					const before = await safeSocketFingerprint(realPath);
					if (done) return;
					upstream = net.createConnection({ path: realPath });
					activeUpstreams.add(upstream);
					upstream.once("close", () => activeUpstreams.delete(upstream!));
					upstream.setEncoding("utf8");
					upstream.once("error", (error) => finish(error));
					upstream.once("end", () =>
						finish(new Error("Herdr closed before a response")),
					);
					upstream.once("close", () =>
						finish(new Error("Herdr closed before a response")),
					);
					upstream.on("data", (chunk: string) => {
						if (!postConnectValidated || !writeDispatched) {
							finish(new Error("Herdr sent unsolicited data before request validation"));
							return;
						}
						response += chunk;
						if (Buffer.byteLength(response, "utf8") > MAX_RELAY_RESPONSE_BYTES + 1) {
							finish(new Error("Herdr response exceeds the 16KiB relay bound"));
							return;
						}
						const newline = response.indexOf("\n");
						if (newline < 0) return;
						if (response.length !== newline + 1) {
							finish(new Error("Herdr returned more than one response line"));
							return;
						}
						if (Buffer.byteLength(response.slice(0, newline), "utf8") > MAX_RELAY_RESPONSE_BYTES) {
							finish(new Error("Herdr response exceeds the 16KiB relay bound"));
							return;
						}
						finish(undefined, response.slice(0, newline));
					});
					upstream.once("connect", async () => {
						try {
							if (done) return;
							const after = await safeSocketFingerprint(realPath);
							if (done) return;
							if (
								before.dev !== after.dev ||
								before.ino !== after.ino ||
								before.uid !== after.uid
							) {
								finish(new Error("Herdr socket changed during relay connection"));
								return;
							}
							postConnectValidated = true;
							writeDispatched = true;
							upstream?.write(`${line}\n`, (error) => {
								if (error) finish(error);
							});
						} catch (error) {
							finish(error instanceof Error ? error : new Error("Herdr socket validation failed"));
						}
					});
				} catch (error) {
					finish(error instanceof Error ? error : new Error("Herdr socket validation failed"));
				}
			})();
		});
	const server = net.createServer((downstream) => {
		activeDownstreams.add(downstream);
		downstream.once("close", () => activeDownstreams.delete(downstream));
		downstream.on("error", () => {});
		downstream.setEncoding("utf8");
		let buffer = "";
		let handled = false;
		downstream.on("data", (chunk: string) => {
			if (handled) {
				downstream.destroy();
				return;
			}
			buffer += chunk;
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			if (buffer.length !== newline + 1) {
				downstream.destroy();
				return;
			}
			handled = true;
			const line = buffer.slice(0, newline);
			let request: CapturedRequest;
			try {
				request = JSON.parse(line) as CapturedRequest;
				assert.equal(
					typeof request.id,
					"string",
					"runtime request id must be present",
				);
				assert.equal(
					typeof request.method,
					"string",
					"runtime request method must be present",
				);
				assert.ok(
					request.params && typeof request.params === "object",
					"runtime request params must be present",
				);
			} catch {
				downstream.destroy();
				return;
			}
			captured.push(request);
			notify(request, false);
			void relay(line, downstream)
				.then((response) => {
					if (downstream.destroyed) return;
					acknowledged.push(request);
					notify(request, true);
					downstream.end(`${response}\n`);
				})
				.catch(() => downstream.destroy());
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, resolve);
	});
	await fs.chmod(socketPath, 0o600);
	return {
		socketPath,
		captured,
		acknowledged,
		waitFor,
		close: async () => {
			for (const waiter of waiters.splice(0)) {
				clearTimeout(waiter.timer);
				waiter.reject(new Error("proxy closed"));
			}
			for (const socket of activeUpstreams) socket.destroy();
			for (const socket of activeDownstreams) socket.destroy();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			await fs.rm(directory, { recursive: true, force: true });
		},
	};
}

const listeners = new Map<string, Listener[]>();
const events = {
	on(name: string, listener: Listener) {
		const current = listeners.get(name) ?? [];
		current.push(listener);
		listeners.set(name, current);
		return () =>
			listeners.set(
				name,
				(listeners.get(name) ?? []).filter((item) => item !== listener),
			);
	},
	emit(name: string, payload: unknown) {
		for (const listener of [...(listeners.get(name) ?? [])]) listener(payload);
	},
};
const pi = { events, on() {} } as unknown as ExtensionAPI;
const HOLD_MS = 300;
const sessionId = `live-herdr-${Date.now()}`;
const context = {
	mode: "tui",
	isIdle: () => true,
	sessionManager: { getSessionId: () => sessionId },
};
const runtime = new PresenceRuntime(pi, config);
registerPresenceHooks(pi, runtime);
const askUser = new AskUserPresence(pi);
const subagent = new PiSubagentPresenceProducer({
	emit: (name: string, payload: unknown) => events.emit(name, payload),
	getSchedulerCounts: () => ({ active: 0, queued: 0 }),
	getInteractiveActiveCount: () => 0,
});
const sleep = (milliseconds: number) =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));
const proxy = await createProxy(realSocketPath);
const originalSocketPath = process.env.HERDR_SOCKET_PATH;

try {
	process.env.HERDR_SOCKET_PATH = proxy.socketPath;
	await runtime.startSession(context);
	const startupCurrentClear = await proxy.waitFor(
		(request) =>
			request.method === "pane.report_metadata" &&
			isExactMetadataClearParams(request.params),
		true,
	);
	const startupLegacyClear = await proxy.waitFor(
		(request) =>
			request.method === "pane.report_metadata" &&
			isExactLegacyMetadataClearParams(request.params),
		true,
	);
	const startupSession = await proxy.waitFor(
		(request) =>
			request.method === "pane.report_agent_session" &&
			isExactSessionReport(request.params),
		true,
	);
	const startupAgent = await proxy.waitFor(
		(request) =>
			request.method === "pane.report_agent" &&
			isExactAgentReport(request.params),
		true,
	);
	const startupMetadata = await proxy.waitFor(
		(request) =>
			request.method === "pane.report_metadata" &&
			isExactMetadataIngressParams(request.params),
		true,
	);
	assert.deepEqual(
		[
			startupCurrentClear,
			startupLegacyClear,
			startupSession,
			startupAgent,
			startupMetadata,
		].map((request) => proxy.captured.indexOf(request)),
		[0, 1, 2, 3, 4],
		"startup current clear, legacy clear, session, agent, and ordinary metadata must be distinct and ordered",
	);

	askUser.startSession(context as never);
	const request = askUser.beginRequest(context as never);
	assert.equal(subagent.startSession(sessionId, 1), true);
	assert.equal(
		subagent.publish({
			generation: 1,
			active: [
				{
					id: "live",
					status: "running",
					kind: "foreground",
					agent: "live",
					startedAt: 0,
					updatedAt: 0,
				},
			],
			recent: [],
		}),
		true,
	);
	await sleep(HOLD_MS);
	assert.equal(
		subagent.publish({
			generation: 1,
			active: [],
			recent: [
				{
					id: "live",
					status: "completed",
					kind: "foreground",
					agent: "live",
					startedAt: 0,
					updatedAt: 1,
					completedAt: 1,
				},
			],
		}),
		true,
	);

	const terminalMetadata = await proxy.waitFor((request) => {
		if (request.method !== "pane.report_metadata") return false;
		const projected = request.params.tokens as
			| Record<string, unknown>
			| undefined;
		return (
			projected?.v2_terminals === "subagent:0:0:completed" &&
			projected.v2_subagents === "0,0,0,1,0,0,0"
		);
	}, true);
	const tokens = terminalMetadata.params.tokens as Record<
		string,
		string | null
	>;
	assert.deepEqual(Object.keys(tokens), [
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
	assert.equal(terminalMetadata.params.title, `Pi · ${tokens.summary}`);
	assert.equal(terminalMetadata.params.display_agent, "Pi");
	assert.deepEqual(terminalMetadata.params.state_labels, {
		idle: "Pi is idle",
		working: "Pi is working",
		blocked: "Pi needs attention",
		unknown: "Pi state unknown",
	});
	assert.equal(tokens.v2_interaction, "ask_user:1");
	assert.equal(tokens.v2_subagents, "0,0,0,1,0,0,0");

	askUser.finishRequest(request);
	subagent.stop();
	const withdrawnMetadata = await proxy.waitFor(
		(output) =>
			output.method === "pane.report_metadata" &&
			(output.params.tokens as Record<string, unknown>)?.v2_interaction ===
				null &&
			(output.params.tokens as Record<string, unknown>)?.v2_subagents === null,
		true,
	);
	assert.equal(
		(withdrawnMetadata.params.tokens as Record<string, unknown>).v2_interaction,
		null,
	);
	assert.equal(
		(withdrawnMetadata.params.tokens as Record<string, unknown>).v2_subagents,
		null,
	);

	const beforeTeardown = proxy.captured.length;
	await runtime.shutdownSession(
		(runtime as unknown as { context: object }).context,
	);
	const teardownCurrentClear = await proxy.waitFor(
		(output) =>
			proxy.captured.indexOf(output) >= beforeTeardown &&
			output.method === "pane.report_metadata" &&
			isExactMetadataClearParams(output.params),
		true,
	);
	const teardownLegacyClear = await proxy.waitFor(
		(output) =>
			proxy.captured.indexOf(output) >
				proxy.captured.indexOf(teardownCurrentClear) &&
			output.method === "pane.report_metadata" &&
			isExactLegacyMetadataClearParams(output.params),
		true,
	);
	const teardownAuthorityClear = await proxy.waitFor(
		(output) =>
			proxy.captured.indexOf(output) >
				proxy.captured.indexOf(teardownLegacyClear) &&
			output.method === "pane.clear_agent_authority" &&
			isExactAgentAuthorityClear(output.params),
		true,
	);
	assert.ok(
		proxy.captured.indexOf(teardownCurrentClear) <
			proxy.captured.indexOf(teardownLegacyClear) &&
			proxy.captured.indexOf(teardownLegacyClear) <
				proxy.captured.indexOf(teardownAuthorityClear),
		"teardown must independently order current clear, legacy clear, then authority clear",
	);
	for (const output of proxy.captured.filter(
		(request) => request.method === "pane.report_metadata",
	)) {
		const currentClear = isExactMetadataClearParams(output.params);
		const legacyClear = isExactLegacyMetadataClearParams(output.params);
		assert.equal(
			currentClear ||
				legacyClear ||
				isExactMetadataIngressParams(output.params),
			true,
		);
		assert.deepEqual(
			Object.keys(output.params),
			currentClear
				? [
						"pane_id",
						"source",
						"applies_to_source",
						"agent",
						"seq",
						"clear_title",
						"clear_display_agent",
						"clear_state_labels",
						"tokens",
					]
				: legacyClear
					? ["pane_id", "source", "applies_to_source", "agent", "seq", "tokens"]
					: [
							"pane_id",
							"source",
							"applies_to_source",
							"agent",
							"seq",
							"title",
							"display_agent",
							"state_labels",
							"tokens",
						],
		);
		assert.deepEqual(
			Object.keys(output.params.tokens as object),
			currentClear
				? [...HERDR_METADATA_TOKEN_KEYS]
				: legacyClear
					? [...HERDR_LEGACY_METADATA_TOKEN_KEYS]
					: [...HERDR_METADATA_TOKEN_KEYS],
		);
	}
	console.log(JSON.stringify({ ok: true, holdMs: HOLD_MS }));
} finally {
	askUser.stopSession();
	subagent.stop();
	await runtime.shutdownSession(
		(runtime as unknown as { context: object }).context,
	);
	if (originalSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
	else process.env.HERDR_SOCKET_PATH = originalSocketPath;
	await proxy.close();
}
