import type { PresenceConfig, PresenceMode } from "./config.js";
import type { HerdrIdentity } from "./identity.js";
import {
	COMPANION_METADATA_SOURCE,
	decodeHerdrResponse,
	encodeHerdrRequest,
	HERDR_LEGACY_METADATA_TOKEN_KEYS,
	HERDR_METADATA_TOKEN_KEYS,
	isCanonicalSummary,
	isExactWorkspacePaneListResult,
	isExactWorkspaceReportMetadataResult,
	titleForSummary,
	WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS,
	WORKSPACE_MAIN_SUMMARY_TTL_MS,
	type HerdrMetadataTokens,
	type HerdrMethod,
	type HerdrPresentation,
} from "./protocol.js";
import { HerdrSocketTransport, PresenceTransportError, type QueueLane } from "./transport.js";
import { processCoordinator } from "./process-coordinator.js";
import { hasControlOrBidi } from "./validation.js";

/** This extension takes over the official Pi authority only while it is absent. */
export const LIFECYCLE_SOURCE = "herdr:pi";
export const OWNED_METADATA_TOKENS = HERDR_METADATA_TOKEN_KEYS;
export const LEGACY_METADATA_TOKENS = HERDR_LEGACY_METADATA_TOKEN_KEYS;
const WORKSPACE_OBSERVER_KEYS = [
	"workspace-pane-list",
	"workspace-main-summary",
] as const;
/** Re-send an unchanged successful projection periodically to repair Herdr restarts. */
const ORDINARY_SUCCESS_TTL_MS = 5_000;
/** Herdr's fixed session projection is intentionally ID-only; paths are never sent. */
export type SessionRef = { agent_session_id: string };
/** Queue protection and audible feedback are deliberately independent notification choices. */
export type NotificationOptions = { actionable: boolean; sound: "none" | "done" | "request" };

/** One request per connection is enforced by HerdrSocketTransport; this client never subscribes. */
export class PresenceClient {
	private requestNumber = 0;
	private closed = false;
	private closing = false;
	private teardownPromise: Promise<void> | null = null;
	private keyRevisions = new Map<string, number>();
	private legacyMetadataClear: Promise<void> | null = null;
	private startupMetadataClear: Promise<void> | null = null;
	private sessionAuthorityPrepared = false;
	/** A standalone session write may establish authority before any response. */
	private sessionAuthorityAttempted = false;
	private authorityClearAttempted = false;
	private normalMetadataStarted = false;
	private workspaceSummaryRequest: Promise<void> | null = null;
	private pendingWorkspaceSummary: string | null = null;
	/** Successful ordinary projections only; cleanup and notifications always remain live. */
	private ordinarySuccess = new Map<"agent" | "metadata", { signature: string; acknowledgedAt: number }>();
	private ordinaryInFlight = new Map<"agent" | "metadata", { signature: string; promise: Promise<void> }>();
	/** Notification work is cancellable synchronously at lifecycle fences. */
	private outstandingNotificationKeys = new Map<string, number>();
	constructor(
		private readonly identity: HerdrIdentity,
		private readonly transport: HerdrSocketTransport,
		private readonly config: PresenceConfig,
		private readonly mode: Exclude<PresenceMode, "disabled"> = "standalone",
		/** Injectable only for deterministic projection-freshness tests. */
		private readonly clock: () => number = Date.now,
	) {}
	private get companion(): boolean {
		return this.mode === "companion";
	}
	private get metadataSource(): string {
		return this.companion ? COMPANION_METADATA_SOURCE : LIFECYCLE_SOURCE;
	}
	async reportSession(sessionRef: SessionRef, reason?: string, deadlineAt?: number): Promise<void> {
		if (this.companion || this.expired(deadlineAt)) return;
		const seq = this.next();
		if (seq === undefined) return;
		// A valid write can establish server-side authority even if the response is
		// lost or malformed. Conservatively reserve priority rollback before it.
		this.sessionAuthorityAttempted = true;
		await this.send(
			"pane.report_agent_session",
			{
				pane_id: this.identity.paneId,
				source: LIFECYCLE_SOURCE,
				agent: "pi",
				seq,
				...(safeSessionStartReason(reason)
					? { session_start_source: reason }
					: {}),
				...sessionRef,
			},
			"session",
			"protected",
			false,
			true,
			false,
			deadlineAt,
		);
	}
	async report(
		state: "idle" | "working" | "blocked" | "unknown",
		sessionRef: SessionRef,
		message?: string,
		deadlineAt?: number,
	): Promise<void> {
		if (this.companion || this.expired(deadlineAt)) return;
		const params = {
			pane_id: this.identity.paneId,
			source: LIFECYCLE_SOURCE,
			agent: "pi",
			state,
			...(message ? { message } : {}),
			seq: 0,
			...sessionRef,
		};
		await this.ordinary("agent", "pane.report_agent", params, "agent", deadlineAt);
	}
	/** Herdr v8 renders fixed display fields, a summary-derived title, and the complete V2 token patch. */
	async metadata(
		presentation: HerdrPresentation,
		tokens: HerdrMetadataTokens,
		deadlineAt?: number,
	): Promise<void> {
		if (!this.config.metadata || this.expired(deadlineAt)) return;
		// Await only incomplete startup work. Once its successful completion is
		// recorded, a live metadata edge must enter the transport queue in this
		// call stack, ahead of any following best-effort notification.
		const preparation = this.prepareSessionAuthority(deadlineAt);
		if (!this.sessionAuthorityPrepared) await preparation;
		if (this.expired(deadlineAt)) return;
		this.normalMetadataStarted = true;
		const params = this.companion
			? {
					pane_id: this.identity.paneId,
					source: this.metadataSource,
					applies_to_source: LIFECYCLE_SOURCE,
					seq: 0,
					title: titleForSummary(tokens.summary),
					display_agent: presentation.displayAgent,
					state_labels: presentation.labels,
					tokens,
				}
			: {
					pane_id: this.identity.paneId,
					source: LIFECYCLE_SOURCE,
					applies_to_source: LIFECYCLE_SOURCE,
					agent: "pi",
					seq: 0,
					title: titleForSummary(tokens.summary),
					display_agent: presentation.displayAgent,
					state_labels: presentation.labels,
					tokens,
				};
		await this.ordinary("metadata", "pane.report_metadata", params, "metadata", deadlineAt);
	}
	/**
	 * Clear both owned V2 chunks before this client restores pane authority.
	 * They are separate exact requests because the legacy chunk has 12 keys and
	 * the current chunk has 10, preserving the 16-token request bound.
	 */
	prepareSessionAuthority(deadlineAt?: number): Promise<void> {
		if (this.sessionAuthorityPrepared || this.normalMetadataStarted || this.expired(deadlineAt))
			return Promise.resolve();
		if (!this.startupMetadataClear)
			this.startupMetadataClear = (async () => {
				await this.clearCurrentMetadata("metadata-startup-clear", false, deadlineAt);
				if (!this.companion && !this.expired(deadlineAt)) await this.clearLegacyMetadata(deadlineAt);
				if (!this.expired(deadlineAt)) this.sessionAuthorityPrepared = true;
			})();
		return this.startupMetadataClear;
	}
	/** Clear pre-V2-only owned tokens once before normal presentation; it never retries. */
	clearLegacyMetadata(deadlineAt?: number): Promise<void> {
		if (this.companion || this.expired(deadlineAt)) return Promise.resolve();
		if (this.normalMetadataStarted || this.legacyMetadataClear)
			return this.legacyMetadataClear ?? Promise.resolve();
		const seq = this.next();
		if (seq === undefined) return Promise.resolve();
		const clear = this.send(
			"pane.report_metadata",
			{
				pane_id: this.identity.paneId,
				source: LIFECYCLE_SOURCE,
				applies_to_source: LIFECYCLE_SOURCE,
				agent: "pi",
				seq,
				tokens: Object.fromEntries(
					LEGACY_METADATA_TOKENS.map((token) => [token, null]),
				),
			},
			"metadata-legacy-clear",
			"protected",
			false,
			false,
			true,
			deadlineAt,
		).then(() => {});
		this.legacyMetadataClear = clear;
		return clear;
	}
	/** Publish a leased workspace summary only when this is the sole reported Pi pane in its opaque workspace. */
	async workspaceMainSummary(summary: string): Promise<void> {
		if (
			!this.config.metadata ||
			this.closed ||
			this.closing ||
			!isCanonicalSummary(summary)
		)
			return;
		this.pendingWorkspaceSummary = summary;
		if (!this.workspaceSummaryRequest)
			this.workspaceSummaryRequest = this.drainWorkspaceMainSummary();
		return this.workspaceSummaryRequest;
	}
	/** Clear the drain marker in-band so an arriving summary starts a new drain, never an orphaned pending value. */
	private async drainWorkspaceMainSummary(): Promise<void> {
		while (
			!this.closed &&
			!this.closing &&
			this.pendingWorkspaceSummary !== null
		) {
			const pending = this.pendingWorkspaceSummary;
			this.pendingWorkspaceSummary = null;
			await this.publishWorkspaceMainSummary(pending);
		}
		this.workspaceSummaryRequest = null;
	}
	private async publishWorkspaceMainSummary(summary: string): Promise<void> {
		const listed = await this.read(
			"pane.list",
			{ workspace_id: this.identity.workspaceId },
			"workspace-pane-list",
		);
		// The list request may finish after synchronous replacement/shutdown fencing.
		// Never let that stale eligibility snapshot dispatch a workspace write.
		if (
			this.closed ||
			this.closing ||
			!isExactWorkspacePaneListResult(listed, this.identity.workspaceId)
		)
			return;
		const piPanes = listed.panes.filter((pane) => pane.agent === "pi");
		if (piPanes.length !== 1 || piPanes[0]?.pane_id !== this.identity.paneId)
			return;
		const seq = this.next();
		if (seq === undefined || this.closed || this.closing) return;
		await this.reportWorkspaceMainSummary({
			workspace_id: this.identity.workspaceId,
			source: COMPANION_METADATA_SOURCE,
			seq,
			ttl_ms: WORKSPACE_MAIN_SUMMARY_TTL_MS,
			tokens: { main_summary: summary },
		});
	}
	/** A workspace lease write has one fixed bounded attempt and accepts only Herdr's exact acknowledgment. */
	private async reportWorkspaceMainSummary(
		params: Record<string, unknown>,
	): Promise<void> {
		if (this.closed || this.closing) return;
		const id = `${this.metadataSource}:${++this.requestNumber}`;
		try {
			const line = encodeHerdrRequest({
				id,
				method: "workspace.report_metadata",
				params,
			});
			const result = decodeHerdrResponse(
				await this.transport.request(
					line,
					"workspace-main-summary",
					false,
					WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS,
					undefined,
					undefined,
					"replaceable",
				),
				id,
			);
			if (!isExactWorkspaceReportMetadataResult(result)) return;
		} catch {
			/* workspace output is observer-only */
		}
	}
	/** Explicitly clear every owned presentation field and null every fixed token. */
	async clearMetadata(deadlineAt?: number): Promise<void> {
		await this.clearCurrentMetadata("metadata-clear", true, deadlineAt);
	}
	private async clearCurrentMetadata(key: string, retry = true, deadlineAt?: number): Promise<void> {
		if (this.expired(deadlineAt)) return;
		const seq = this.next();
		if (seq === undefined) return;
		const tokens = Object.fromEntries(
			OWNED_METADATA_TOKENS.map((token) => [token, null]),
		);
		const params = this.companion
			? {
					pane_id: this.identity.paneId,
					source: this.metadataSource,
					applies_to_source: LIFECYCLE_SOURCE,
					seq,
					clear_title: true,
					clear_display_agent: true,
					clear_state_labels: true,
					tokens,
				}
			: {
					pane_id: this.identity.paneId,
					source: LIFECYCLE_SOURCE,
					applies_to_source: LIFECYCLE_SOURCE,
					agent: "pi",
					seq,
					clear_title: true,
					clear_display_agent: true,
					clear_state_labels: true,
					tokens,
				};
		await this.send("pane.report_metadata", params, key, "protected", true, retry, true, deadlineAt);
	}
	/** Teardown repeats the exact legacy chunk only for standalone ownership. */
	private async clearLegacyMetadataOnTeardown(deadlineAt?: number): Promise<void> {
		if (this.companion || this.expired(deadlineAt)) return;
		const seq = this.next();
		if (seq === undefined) return;
		await this.send(
			"pane.report_metadata",
			{
				pane_id: this.identity.paneId,
				source: LIFECYCLE_SOURCE,
				applies_to_source: LIFECYCLE_SOURCE,
				agent: "pi",
				seq,
				tokens: Object.fromEntries(
					LEGACY_METADATA_TOKENS.map((token) => [token, null]),
				),
			},
			"metadata-teardown-legacy-clear",
			"protected",
			true,
			false,
			true,
			deadlineAt,
		);
	}
	/**
	 * A visible toast has unknown delivery after dispatch and is never retried.
	 * The return value is only a synchronous queue-admission receipt; it is not
	 * an acknowledgement from Herdr.
	 */
	notify(
		title: string,
		body: string,
		options: NotificationOptions,
		key = "default",
	): boolean {
		if (!this.config.notifications || this.closed || this.closing) return false;
		const id = `${this.metadataSource}:${++this.requestNumber}`;
		let line: string;
		try {
			line = encodeHerdrRequest({
				id,
				method: "notification.show",
				params: { title, body, sound: options.sound },
			});
		} catch {
			return false;
		}
		let admitted = false;
		let receivedAdmission = false;
		const transportKey = `notification:${key}`;
		let tracked = false;
		const request = this.transport.request(
			line,
			transportKey,
			false,
			this.config.timeoutMs,
			undefined,
			undefined,
			options.actionable ? "actionable" : "replaceable",
			(value) => {
				receivedAdmission = true;
				admitted = value;
				if (value) {
					tracked = true;
					this.outstandingNotificationKeys.set(
						transportKey,
						(this.outstandingNotificationKeys.get(transportKey) ?? 0) + 1,
					);
				}
			},
		);
		// Once queued, delivery may fail after dispatch. Validate a settled response
		// only for protocol containment; it must never alter admission or retry.
		void request.then(
			(response) => {
				try {
					decodeHerdrResponse(response, id);
				} catch {
					/* notification output is observer-only */
				}
			},
			() => {},
		).finally(() => {
			if (!tracked) return;
			const count = this.outstandingNotificationKeys.get(transportKey);
			if (count === undefined || count <= 1)
				this.outstandingNotificationKeys.delete(transportKey);
			else this.outstandingNotificationKeys.set(transportKey, count - 1);
		}).catch(() => {});
		return receivedAdmission && admitted;
	}
	/** Herdr's existing authority clear is priority cleanup and is never retried. */
	private async clearAgentAuthority(deadlineAt?: number): Promise<void> {
		if (this.authorityClearAttempted || this.expired(deadlineAt)) return;
		this.authorityClearAttempted = true;
		const seq = this.next();
		if (seq === undefined) return;
		await this.send(
			"pane.clear_agent_authority",
			{ pane_id: this.identity.paneId, source: LIFECYCLE_SOURCE, seq },
			"clear-agent-authority",
			"protected",
			true,
			false,
			true,
			deadlineAt,
		);
	}
	/** Roll back attempted standalone authority first, then clear presentation within one deadline. */
	teardown(timeoutMs = this.config.timeoutMs): Promise<void> {
		const budget = Number.isFinite(timeoutMs) ? Math.max(0, timeoutMs) : this.config.timeoutMs;
		return this.teardownUntil(Date.now() + budget);
	}
	teardownUntil(deadlineAt: number): Promise<void> {
		if (this.teardownPromise) return this.teardownPromise;
		if (this.closed) return Promise.resolve();
		this.fenceOrdinaryOutput();
		this.teardownPromise = this.performTeardown(deadlineAt);
		return this.teardownPromise;
	}
	private async performTeardown(deadlineAt: number): Promise<void> {
		if (this.expired(deadlineAt)) {
			await this.close(0).catch(() => {});
			return;
		}
		let expired = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expires = new Promise<void>((resolve) => {
			const remaining = this.remaining(deadlineAt);
			timer = setTimeout(() => {
				expired = true;
				void this.close(0).catch(() => {});
				resolve();
			}, remaining);
			timer.unref?.();
		});
		try {
			// Session authority can outlive a lost, malformed, or acknowledged startup
			// response. Roll it back before presentation cleanup consumes the reserve.
			if (!this.companion && this.sessionAuthorityAttempted)
				await Promise.race([
					this.clearAgentAuthority(deadlineAt).catch(() => {}),
					expires,
				]);
			if (!expired && !this.closed)
				await Promise.race([this.clearMetadata(deadlineAt).catch(() => {}), expires]);
			if (!expired && !this.closed && !this.companion)
				await Promise.race([
					this.clearLegacyMetadataOnTeardown(deadlineAt).catch(() => {}),
					expires,
				]);
			if (!expired && !this.closed && !this.companion)
				await Promise.race([
					this.clearAgentAuthority(deadlineAt).catch(() => {}),
					expires,
				]);
			const remaining = deadlineAt - Date.now();
			if (!expired && !this.closed)
				await Promise.race([
					this.close(
						Number.isFinite(remaining) ? Math.max(0, remaining) : 0,
					).catch(() => {}),
					expires,
				]);
		} finally {
			if (timer) clearTimeout(timer);
			// `expires` may leave a cleanup request running against a non-cooperative
			// transport mock. It is contained above, and close prevents any retry.
		}
	}
	/** Synchronously stop ordinary output while preserving explicitly marked teardown requests. */
	fenceOrdinaryOutput(): void {
		this.closing = true;
		this.pendingWorkspaceSummary = null;
		this.cancelOutstandingNotifications();
		this.cancelWorkspaceObservers();
	}
	async close(timeoutMs?: number): Promise<void> {
		this.fenceOrdinaryOutput();
		this.closed = true;
		await this.transport.close(timeoutMs);
	}
	private remaining(deadlineAt?: number): number {
		if (deadlineAt === undefined) return this.config.timeoutMs;
		const remaining = deadlineAt - Date.now();
		return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
	}
	private expired(deadlineAt?: number): boolean {
		return deadlineAt !== undefined && this.remaining(deadlineAt) <= 0;
	}
	private async requestBeforeDeadline(
		line: string,
		key: string,
		lane: QueueLane,
		priority: boolean,
		timeoutMs: number,
		preempt?: readonly string[],
		deadlineAt?: number,
	): Promise<string> {
		if (deadlineAt !== undefined && this.remaining(deadlineAt) <= 0)
			throw new PresenceTransportError("Socket request timed out.");
		const request = this.transport.request(line, key, priority, timeoutMs, preempt, deadlineAt, lane);
		if (deadlineAt === undefined) return request;
		const remaining = this.remaining(deadlineAt);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([request, new Promise<string>((_resolve, reject) => {
				timer = setTimeout(() => reject(new PresenceTransportError("Socket request timed out.")), remaining);
				timer.unref?.();
			})]);
		} finally { if (timer) clearTimeout(timer); }
	}
	private async ordinary(
		channel: "agent" | "metadata",
		method: Extract<HerdrMethod, "pane.report_agent" | "pane.report_metadata">,
		params: Record<string, unknown>,
		key: string,
		deadlineAt?: number,
	): Promise<void> {
		let signature: string;
		try { signature = semanticSignature(method, params); } catch { return; }
		const acknowledged = this.ordinarySuccess.get(channel);
		if (acknowledged?.signature === signature && this.successIsFresh(acknowledged.acknowledgedAt)) return;
		const pending = this.ordinaryInFlight.get(channel);
		if (pending?.signature === signature) return pending.promise;
		// A newer distinct desired projection invalidates an older acknowledged
		// value; a later stale failure never mutates this success cache.
		this.ordinarySuccess.delete(channel);
		if (this.expired(deadlineAt)) return;
		// Do not allocate a sequence after a semantic cache or in-flight hit.
		const seq = this.next();
		if (seq === undefined) return;
		let promise!: Promise<void>;
		promise = this.send(method, { ...params, seq }, key, channel === "metadata" ? "replaceable" : "protected", false, true, false, deadlineAt).then((acknowledged) => {
			if (acknowledged && this.ordinaryInFlight.get(channel)?.promise === promise)
				this.ordinarySuccess.set(channel, { signature, acknowledgedAt: this.clock() });
		}).finally(() => {
			if (this.ordinaryInFlight.get(channel)?.promise === promise)
				this.ordinaryInFlight.delete(channel);
		});
		this.ordinaryInFlight.set(channel, { signature, promise });
		return promise;
	}
	private successIsFresh(acknowledgedAt: number): boolean {
		const age = this.clock() - acknowledgedAt;
		return Number.isFinite(age) && age >= 0 && age < ORDINARY_SUCCESS_TTL_MS;
	}
	private next(): number | undefined {
		try {
			const sequence = processCoordinator.nextSequence();
			return typeof sequence === "number" &&
				Number.isSafeInteger(sequence) &&
				sequence >= 0
				? sequence
				: undefined;
		} catch {
			return undefined;
		}
	}
	/** Read-only workspace eligibility is one bounded attempt; malformed or remote responses are never eligible. */
	private async read(
		method: Extract<HerdrMethod, "pane.list">,
		params: Record<string, unknown>,
		key: string,
	): Promise<unknown | undefined> {
		if (this.closed || this.closing) return undefined;
		const id = `${this.metadataSource}:${++this.requestNumber}`;
		try {
			const line = encodeHerdrRequest({ id, method, params });
			return decodeHerdrResponse(
				await this.transport.request(
					line,
					key,
					false,
					WORKSPACE_MAIN_SUMMARY_REQUEST_TIMEOUT_MS,
					undefined,
					undefined,
					"replaceable",
				),
				id,
			);
		} catch {
			return undefined;
		}
	}
	/** Shutdown fences observer work, while ordinary output reserves preemption atomically in transport. */
	private cancelWorkspaceObservers(): void {
		for (const key of WORKSPACE_OBSERVER_KEYS) this.transport.cancel(key);
	}
	private cancelOutstandingNotifications(): void {
		for (const key of this.outstandingNotificationKeys.keys()) this.transport.cancel(key);
	}
	/** Lifecycle requests use two bounded attempts. */
	private async send(
		method: HerdrMethod,
		params: Record<string, unknown>,
		key: string,
		lane: QueueLane,
		priority = false,
		retry = true,
		cleanup = false,
		deadlineAt?: number,
	): Promise<boolean> {
		if (this.closed || (this.closing && !cleanup) || this.expired(deadlineAt)) return false;
		const revision = (this.keyRevisions.get(key) ?? 0) + 1;
		this.keyRevisions.set(key, revision);
		const id = `${this.metadataSource}:${++this.requestNumber}`;
		// This deadline starts before transport preemption. An unabortable observer
		// fingerprint may delay dispatch, but can never extend lifecycle output.
		const now = Date.now();
		const requestDeadlineAt = deadlineAt ?? (Number.isFinite(now) ? now + this.config.timeoutMs : undefined);
		try {
			let line: string;
			// Validation and serialization are output-only too: never dispatch or reject lifecycle work.
			try {
				line = encodeHerdrRequest({ id, method, params });
			} catch {
				return false;
			}
			const totalRemaining = requestDeadlineAt === undefined ? this.config.timeoutMs : this.remaining(requestDeadlineAt);
			const firstTimeout = Math.max(1, Math.floor(totalRemaining / 2));
			const retryTimeout = Math.max(0, totalRemaining - firstTimeout);
			const request = async (attemptTimeout: number): Promise<string> => {
				const remaining = requestDeadlineAt === undefined ? this.config.timeoutMs : this.remaining(requestDeadlineAt);
				if (attemptTimeout <= 0 || remaining <= 0)
					throw new PresenceTransportError("Socket request timed out.");
				return this.requestBeforeDeadline(
					line,
					key,
					lane,
					priority,
					Math.min(attemptTimeout, remaining),
					cleanup || lane === "actionable" ? undefined : WORKSPACE_OBSERVER_KEYS,
					requestDeadlineAt,
				);
			};
			try {
				decodeHerdrResponse(await request(firstTimeout), id);
				return true;
			} catch (error) {
				// Transport does not distinguish pre-dispatch failures from timeout/EOF.
				if (
					!retry ||
					this.closed ||
					this.closing ||
					this.keyRevisions.get(key) !== revision ||
					(error instanceof PresenceTransportError &&
						/^Socket queue (coalesced|displaced|closed|is full)/.test(
							error.message,
						))
				)
					return false;
				try {
					decodeHerdrResponse(await request(retryTimeout), id);
					return true;
				} catch {
					return false;
				}
			}
		} finally {
			// A completed current revision cannot supersede future work, so retaining
			// it only grows this per-session coalescing fence.
			if (this.keyRevisions.get(key) === revision)
				this.keyRevisions.delete(key);
		}
	}
}

/** Canonical wire semantics deliberately exclude generated request id and sequence. */
function semanticSignature(method: string, params: Record<string, unknown>): string {
	const { seq: _sequence, ...semantics } = params;
	return `${method}:${stableJson(semantics)}`;
}
function stableJson(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
}

function safeSessionStartReason(reason: unknown): reason is string {
	return (
		typeof reason === "string" &&
		reason.length > 0 &&
		Buffer.byteLength(reason, "utf8") <= 512 &&
		!hasControlOrBidi(reason)
	);
}
