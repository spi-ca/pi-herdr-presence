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
import { HerdrSocketTransport, PresenceTransportError } from "./transport.js";
import { processCoordinator } from "./process-coordinator.js";
import { hasControlOrBidi } from "./validation.js";

/** This extension takes over the official Pi authority only while it is absent. */
export const LIFECYCLE_SOURCE = "herdr:pi";
export const OWNED_METADATA_TOKENS = HERDR_METADATA_TOKEN_KEYS;
export const LEGACY_METADATA_TOKENS = HERDR_LEGACY_METADATA_TOKEN_KEYS;
/** Herdr's fixed session projection is intentionally ID-only; paths are never sent. */
export type SessionRef = { agent_session_id: string };

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
	private normalMetadataStarted = false;
	private workspaceSummaryRequest: Promise<void> | null = null;
	private pendingWorkspaceSummary: string | null = null;
	constructor(
		private readonly identity: HerdrIdentity,
		private readonly transport: HerdrSocketTransport,
		private readonly config: PresenceConfig,
		private readonly mode: Exclude<PresenceMode, "disabled"> = "standalone",
	) {}
	private get companion(): boolean {
		return this.mode === "companion";
	}
	private get metadataSource(): string {
		return this.companion ? COMPANION_METADATA_SOURCE : LIFECYCLE_SOURCE;
	}
	async reportSession(sessionRef: SessionRef, reason?: string): Promise<void> {
		if (this.companion) return;
		const seq = this.next();
		if (seq === undefined) return;
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
		);
	}
	async report(
		state: "idle" | "working" | "blocked" | "unknown",
		sessionRef: SessionRef,
		message?: string,
	): Promise<void> {
		if (this.companion) return;
		const seq = this.next();
		if (seq === undefined) return;
		await this.send(
			"pane.report_agent",
			{
				pane_id: this.identity.paneId,
				source: LIFECYCLE_SOURCE,
				agent: "pi",
				state,
				...(message ? { message } : {}),
				seq,
				...sessionRef,
			},
			"agent",
		);
	}
	/** Herdr v8 renders fixed display fields, a summary-derived title, and the complete V2 token patch. */
	async metadata(
		presentation: HerdrPresentation,
		tokens: HerdrMetadataTokens,
	): Promise<void> {
		if (!this.config.metadata) return;
		// Await only incomplete startup work. Once its successful completion is
		// recorded, a live metadata edge must enter the transport queue in this
		// call stack, ahead of any following best-effort notification.
		const preparation = this.prepareSessionAuthority();
		if (!this.sessionAuthorityPrepared) await preparation;
		this.normalMetadataStarted = true;
		const seq = this.next();
		if (seq === undefined) return;
		const params = this.companion
			? {
					pane_id: this.identity.paneId,
					source: this.metadataSource,
					applies_to_source: LIFECYCLE_SOURCE,
					seq,
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
					seq,
					title: titleForSummary(tokens.summary),
					display_agent: presentation.displayAgent,
					state_labels: presentation.labels,
					tokens,
				};
		await this.send("pane.report_metadata", params, "metadata");
	}
	/**
	 * Clear both owned V2 chunks before this client restores pane authority.
	 * They are separate exact requests because the legacy chunk has 12 keys and
	 * the current chunk has 10, preserving the 16-token request bound.
	 */
	prepareSessionAuthority(): Promise<void> {
		if (this.sessionAuthorityPrepared || this.normalMetadataStarted)
			return Promise.resolve();
		if (!this.startupMetadataClear)
			this.startupMetadataClear = (async () => {
				await this.clearCurrentMetadata("metadata-startup-clear", false);
				if (!this.companion) await this.clearLegacyMetadata();
				this.sessionAuthorityPrepared = true;
			})();
		return this.startupMetadataClear;
	}
	/** Clear pre-V2-only owned tokens once before normal presentation; it never retries. */
	clearLegacyMetadata(): Promise<void> {
		if (this.companion) return Promise.resolve();
		if (this.normalMetadataStarted || this.legacyMetadataClear)
			return this.legacyMetadataClear ?? Promise.resolve();
		const seq = this.next();
		if (seq === undefined) return Promise.resolve();
		this.legacyMetadataClear = this.send(
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
			false,
			false,
			true,
		);
		return this.legacyMetadataClear;
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
				),
				id,
			);
			if (!isExactWorkspaceReportMetadataResult(result)) return;
		} catch {
			/* workspace output is observer-only */
		}
	}
	/** Explicitly clear every owned presentation field and null every fixed token. */
	async clearMetadata(): Promise<void> {
		await this.clearCurrentMetadata("metadata-clear");
	}
	private async clearCurrentMetadata(key: string, retry = true): Promise<void> {
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
		await this.send("pane.report_metadata", params, key, true, retry, true);
	}
	/** Teardown repeats the exact legacy chunk only for standalone ownership. */
	private async clearLegacyMetadataOnTeardown(): Promise<void> {
		if (this.companion) return;
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
			true,
			false,
			true,
		);
	}
	/** A visible toast has unknown delivery after dispatch, so it is never retried. */
	async notify(
		title: string,
		body: string,
		error = false,
		key = "default",
	): Promise<void> {
		if (!this.config.notifications) return;
		await this.send(
			"notification.show",
			{ title, body, sound: error ? "request" : "done" },
			`notification:${key}`,
			false,
			false,
		);
	}
	/** Herdr's existing authority clear is priority cleanup and is never retried. */
	private async clearAgentAuthority(): Promise<void> {
		const seq = this.next();
		if (seq === undefined) return;
		await this.send(
			"pane.clear_agent_authority",
			{ pane_id: this.identity.paneId, source: LIFECYCLE_SOURCE, seq },
			"clear-agent-authority",
			true,
			false,
			true,
		);
	}
	/** Clear metadata then authority within one deadline; expiry aborts later dispatch. */
	teardown(timeoutMs = this.config.timeoutMs): Promise<void> {
		if (this.teardownPromise) return this.teardownPromise;
		if (this.closed) return Promise.resolve();
		// Fence ordinary reports and their retries before cleanup enters the queue.
		this.fenceOrdinaryOutput();
		this.teardownPromise = this.performTeardown(timeoutMs);
		return this.teardownPromise;
	}
	private async performTeardown(timeoutMs: number): Promise<void> {
		const budget = Number.isFinite(timeoutMs)
			? Math.max(0, timeoutMs)
			: this.config.timeoutMs;
		if (budget <= 0) {
			await this.close(0).catch(() => {});
			return;
		}
		const deadlineAt = Date.now() + budget;
		let expired = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const expires = new Promise<void>((resolve) => {
			timer = setTimeout(() => {
				expired = true;
				void this.close(0).catch(() => {});
				resolve();
			}, budget);
			timer.unref?.();
		});
		try {
			await Promise.race([this.clearMetadata().catch(() => {}), expires]);
			if (!expired && !this.closed && !this.companion)
				await Promise.race([
					this.clearLegacyMetadataOnTeardown().catch(() => {}),
					expires,
				]);
			if (!expired && !this.closed && !this.companion)
				await Promise.race([
					this.clearAgentAuthority().catch(() => {}),
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
		this.transport.cancel("workspace-pane-list");
		this.transport.cancel("workspace-main-summary");
	}
	async close(timeoutMs?: number): Promise<void> {
		this.fenceOrdinaryOutput();
		this.closed = true;
		await this.transport.close(timeoutMs);
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
				),
				id,
			);
		} catch {
			return undefined;
		}
	}
	/** Lifecycle requests use two bounded attempts. */
	private async send(
		method: HerdrMethod,
		params: Record<string, unknown>,
		key: string,
		priority = false,
		retry = true,
		cleanup = false,
	): Promise<void> {
		if (this.closed || (this.closing && !cleanup)) return;
		const revision = (this.keyRevisions.get(key) ?? 0) + 1;
		this.keyRevisions.set(key, revision);
		const id = `${this.metadataSource}:${++this.requestNumber}`;
		try {
			let line: string;
			// Validation and serialization are output-only too: never dispatch or reject lifecycle work.
			try {
				line = encodeHerdrRequest({ id, method, params });
			} catch {
				return;
			}
			const firstTimeout = Math.floor(this.config.timeoutMs / 2);
			const retryTimeout = this.config.timeoutMs - firstTimeout;
			try {
				const response = await this.transport.request(
					line,
					key,
					priority,
					firstTimeout,
				);
				decodeHerdrResponse(response, id);
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
					return;
				try {
					decodeHerdrResponse(
						await this.transport.request(line, key, priority, retryTimeout),
						id,
					);
				} catch {
					/* output-only best effort */
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

function safeSessionStartReason(reason: unknown): reason is string {
	return (
		typeof reason === "string" &&
		reason.length > 0 &&
		Buffer.byteLength(reason, "utf8") <= 512 &&
		!hasControlOrBidi(reason)
	);
}
