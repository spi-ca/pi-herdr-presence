import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createPresenceConsumer, createPresenceProducer, encodeTerminalBatch, MAX_INTEGER, type PresenceConsumerHandle, type PresenceEventV2, type PresenceProducerHandle, type PresenceStateInputV2, type PresenceStateV2, type PresenceTerminalV2, type TerminalBatch } from "@pi/presence";
import { PresenceClient, type SessionRef } from "./client.js";
import { resolvePresenceMode, type PresenceConfig, type PresenceMode } from "./config.js";
import { readHerdrIdentity } from "./identity.js";
import { ExternalAttentionTransitions, NotificationDeduper, NotificationRateLimiter, shouldNotify, type NotificationCooldownKind, type NotificationSeverity } from "./notification-policy.js";
import { officialHookStatus } from "./official-hook.js";
import { processCoordinator } from "./process-coordinator.js";
import { attentionText, compositeState, isInteractionWaiting, isLiveInputRequest, metadata, presentation, safeMessage } from "./presentation.js";
import { HerdrSocketTransport } from "./transport.js";
import { WorkspaceSummaryLease, type WorkspaceSummaryScheduler } from "./workspace-summary.js";
import { TodoProgressAdapter } from "./todo.js";
import { UsageTracker } from "./usage.js";
import { hasControlOrBidi } from "./validation.js";

const MAX_NOTIFICATION_TRANSITIONS = Number.MAX_SAFE_INTEGER;
const MAX_TERMINALS = 3;
/** Unmodified Herdr accepts at most an 80-byte UTF-8 terminal token value. */
const HERDR_TERMINAL_VALUE_MAX_BYTES = 80;
const MAX_TERMINAL_OVERFLOW = 1_000_000;
const MAX_TERMINAL_TOMBSTONES = 64;
const MAX_FAILURE_PAIRS = 64;
/** Detached startup retains only these derived lifecycle edges, never source payloads. */
const MAX_PENDING_LIFECYCLE_EDGES = 64;
/** Live notification edges received after activation cannot grow an unbounded startup backlog. */
const MAX_PENDING_NOTIFICATION_CANDIDATES = 64;
const MAX_DERIVED_USAGE = 1_000_000;
/** A bounded synchronous producer terminal/state pair has no reason to outlive one tick. */
const FAILURE_PAIR_WINDOW_MS = 10;
const EXTERNAL_NOTIFICATION_COALESCE_MS = 50;
/** Startup must reach a stable aggregate snapshot before any observer-visible output opens. */
const MAX_STARTUP_PROJECTION_PASSES = 16;
type SessionManagerProvider = { getSessionId?: () => unknown };
type ContextUsageProvider = { getContextUsage?: () => unknown; isIdle?: () => boolean; sessionManager?: SessionManagerProvider };
type Terminal = "success" | "error" | "cancelled";
type LocalSource = "pi" | "todo";
type FailureArrival = { source: string; generation: number; kind: "state" | "terminal"; acceptedAt: number; expiresAt: number; inputLifecycleId?: number; timer?: ReturnType<typeof setTimeout>; notify?: () => void };
type InputLifecycle = { id: number; acceptedAt: number; endedAt?: number; expiresAt?: number; attempted: boolean; admitted: boolean; purgeTimer?: ReturnType<typeof setTimeout> };
type RuntimeSession = { id: string; ref: SessionRef; manager: SessionManagerProvider };
type DerivedUsage = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: number };
type DerivedTodo = Pick<PresenceStateInputV2, "state" | "progress">;
type PendingLifecycleEdge =
  | { kind: "agent_start" }
  | { kind: "turn_start"; contextPercent?: number }
  | { kind: "agent_end"; terminal?: Terminal }
  | { kind: "agent_settled" }
  | { kind: "message_end"; usage: DerivedUsage }
  | { kind: "tool_result"; failed: boolean; todo?: DerivedTodo };
type PendingLifecycle = { epoch: number; id: string; manager: SessionManagerProvider; context: ContextUsageProvider; edges: PendingLifecycleEdge[]; overflow: boolean; nativePromptWaiting: boolean; nativePromptAcceptedAt: number | null };
type PendingNotificationCandidate =
  | { kind: "input"; acceptedAt: number }
  | { kind: "state"; event: PresenceStateV2; inputPresent: boolean; acceptedAt: number }
  | { kind: "terminal"; event: PresenceTerminalV2; acceptedAt: number }
  | { kind: "withdraw"; inputPresent: boolean; acceptedAt: number };

function sessionManager(context: unknown): SessionManagerProvider | null {
  try {
    const manager = (context as ContextUsageProvider | undefined)?.sessionManager;
    return typeof manager === "object" && manager !== null ? manager : null;
  } catch { return null; }
}
function session(context: unknown): RuntimeSession | null {
  try {
    const manager = sessionManager(context);
    if (!manager) return null;
    const id = manager.getSessionId?.();
    if (typeof id !== "string" || id.length === 0 || Buffer.byteLength(id, "utf8") > 128 || hasControlOrBidi(id)) return null;
    return { id, ref: { agent_session_id: id }, manager };
  } catch { return null; }
}
/** Callback wrappers may omit mode, but an explicit non-TUI mode is never eligible for native UI state. */
function isTuiCallback(context: unknown): boolean {
  try {
    const mode = (context as { mode?: unknown } | undefined)?.mode;
    return mode === undefined || mode === "tui";
  } catch { return false; }
}
function derivedNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(MAX_DERIVED_USAGE, value) : undefined; }
function deriveUsage(event: unknown): DerivedUsage | undefined {
  const message = (event as { message?: { role?: unknown; usage?: unknown } })?.message;
  if (message?.role !== "assistant" || typeof message.usage !== "object" || message.usage === null) return undefined;
  const usage = message.usage as { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; totalTokens?: unknown; cost?: unknown };
  const cost = typeof usage.cost === "object" && usage.cost !== null ? (usage.cost as { total?: unknown }).total : usage.cost;
  const derived: DerivedUsage = {};
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) {
    const value = derivedNumber(usage[key]);
    if (value !== undefined) derived[key] = value;
  }
  const safeCost = derivedNumber(cost);
  if (safeCost !== undefined) derived.cost = safeCost;
  return derived;
}
function deriveContextPercent(context: ContextUsageProvider): number | undefined {
  try {
    const usage = context.getContextUsage?.();
    if (typeof usage !== "object" || usage === null) return undefined;
    const candidate = usage as { contextPercent?: unknown; percent?: unknown };
    const value = candidate.contextPercent ?? candidate.percent;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : undefined;
  } catch { return undefined; }
}

/** The last terminal message wins: an automatic retry can legitimately recover an earlier failure. */
export function deriveTerminalState(event: unknown, toolFailed = false): Terminal {
  return deriveExplicitTerminal(event) ?? (toolFailed ? "error" : "success");
}

/** An absent stop reason is resolved only by the current turn's tool reducer. */
function deriveExplicitTerminal(event: unknown): Terminal | undefined {
  const messages = (event as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const reason = (messages[index] as { stopReason?: unknown })?.stopReason;
    if (reason === "aborted" || reason === "cancelled") return "cancelled";
    if (reason === "error") return "error";
    if (typeof reason === "string") return "success";
  }
  return undefined;
}

/** Session-epoch-fenced composite renderer. It consumes generic retained sources without importing producers. */
export class PresenceRuntime {
  private todo = new TodoProgressAdapter();
  private client: PresenceClient | null = null;
  /** Process-global ownership fences a stale cache-busted runtime's teardown. */
  private authorityGeneration: number | null = null;
  /** Selected only after the managed-hook probe; disabled never acquires local resources. */
  private mode: PresenceMode = "disabled";
  private consumer: PresenceConsumerHandle | null = null;
  /** The exact opaque ready capability emitted by the active consumer. */
  private consumerReady: PresenceConsumerHandle["ready"] | null = null;
  private consumerActive = false;
  /** Replay is retained state, not a live output edge, until session ownership settles. */
  private outputReady = false;
  /** True only while consumer.activate() synchronously replays retained state/ready. */
  private activationReplay = false;
  /** Post-activation live edges await the initial projection without duplicating it. */
  private pendingNotifications: PendingNotificationCandidate[] = [];
  private pendingNotificationsOverflow = false;
  /** An internal-only output path keeps startup projection atomic to observers. */
  private initialProjectionInFlight = false;
  private initialProjectionDirty = false;
  private notificationAcceptanceTime = 0;
  private localPi: PresenceProducerHandle | null = null;
  private localTodo: PresenceProducerHandle | null = null;
  private localPiActive = false;
  private localTodoActive = false;
  /** Set while a max-ordinal source rotation requires fresh, rather than retained, snapshots. */
  private rotationPending = false;
  private lastPiState: PresenceStateInputV2 | null = null;
  private lastTodoState: PresenceStateInputV2 | null = null;
  private readonly states = new Map<PresenceStateV2["source"], PresenceStateV2>();
  private terminalRecords: PresenceTerminalV2[] = [];
  /** Fixed-TTL LRU fence for terminal identities across producer replacement. */
  private readonly terminalTombstones = new Map<string, PresenceTerminalV2["outcome"]>();
  private terminalOverflow = 0;
  private sessionId: string | null = null;
  private sessionRef: SessionRef | null = null;
  private context: ContextUsageProvider | null = null;
  /** Stable owner captured from session_start; Pi creates a fresh context wrapper per callback. */
  private sessionManager: SessionManagerProvider | null = null;
  /** Null synchronously fences ingress, output, and notifications during replacement/teardown. */
  private ingressEpoch: number | null = null;
  private epoch = 0;
  /** The active owner must belong to the current epoch, not merely share an ID. */
  private ownerEpoch = 0;
  /** One startup can retain only one immediate lifecycle edge sequence. */
  private pendingLifecycle: PendingLifecycle | null = null;
  private transitions: Promise<void> = Promise.resolve();
  /** At most one stale startup and one newest replacement can await a probe. */
  private queuedStartup: { work: () => Promise<void>; resolve: () => void } | null = null;
  private startupRunner: Promise<void> | null = null;
  private generation = 0;
  private sequence = 0;
  private terminalEventId = 0;
  private active = false;
  private rootSession = false;
  /** Native TUI prompt lifecycle, fenced to the owning root-session epoch. */
  private nativePromptEpoch: number | null = null;
  private inputLifecycleActive = false;
  /** Balanced companion-only ownership of the managed Herdr blocked counter. */
  private companionBlocked = false;
  private inputNotificationPending = false;
  private inputNotificationAttempted = false;
  /** Bounded session-local receipts bind failures to their exact aggregate input lifecycle. */
  private readonly inputLifecycles: InputLifecycle[] = [];
  private nextInputLifecycleId = 0;
  private currentInputLifecycleId: number | null = null;
  /** Coalesce only simultaneous input lifecycles; distinct terminal edges stay live. */
  private inputNotificationTransitions = 0;
  private turn = 0;
  private toolFailed = false;
  private terminal: Terminal = "success";
  private usage = new UsageTracker();
  /** Fixed TTL for the current bounded terminal batch; bursts never extend it. */
  private terminalClearTimer: ReturnType<typeof setTimeout> | undefined;
  /** The workspace lease is observer-only and independently paced below its fixed TTL. */
  private readonly workspaceLease: WorkspaceSummaryLease;
  private longRunningTimer: ReturnType<typeof setTimeout> | undefined;
  private externalAttention = new ExternalAttentionTransitions();
  private notifications = new NotificationDeduper();
  private notificationRate = new NotificationRateLimiter();
  private readonly failureArrivals: FailureArrival[] = [];
  private externalPending: { severity: "error" | "success" | "info"; title: string; body: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private externalNotificationSequence = 0;

  constructor(
    private pi: ExtensionAPI,
    private config: PresenceConfig,
    workspaceScheduler?: WorkspaceSummaryScheduler,
    private notificationClock: () => number = () => Number(process.hrtime.bigint() / 1_000_000n),
  ) {
    this.workspaceLease = new WorkspaceSummaryLease({
      workspaceMainSummary: async (summary) => {
        const client = this.client;
        if (!this.config.metadata || !this.canOutput() || !client) return;
        await client.workspaceMainSummary(summary);
      },
    }, workspaceScheduler);
  }

  async startSession(context: unknown, event?: unknown) {
    const deadlineAt = this.lifecycleDeadline();
    // A replacement must release the managed integration's counter and fence
    // ordinary client output synchronously, before teardown/probing can await.
    this.releaseCompanionBlocked();
    this.nativePromptEpoch = null;
    this.client?.fenceOrdinaryOutput();
    this.workspaceLease.stop();
    const epoch = ++this.epoch;
    // A session boundary permits a distinct Todo implementation in the new root.
    this.todo.reset();
    this.clearPendingNotifications();
    this.resetInputNotificationState();
    this.clearInputLifecycles();
    this.notificationAcceptanceTime = 0;
    // A replacement must not leave the previous consumer able to accept same-tick ingress.
    this.ingressEpoch = null;
    const current = session(context);
    this.pendingLifecycle = (context as { mode?: unknown })?.mode === "tui" && current
      ? { epoch, id: current.id, manager: current.manager, context: context as ContextUsageProvider, edges: [], overflow: false, nativePromptWaiting: false, nativePromptAcceptedAt: null }
      : null;
    return this.settleByDeadline(
      this.queueStartup(() => this.beginSession(context, event, epoch, current, deadlineAt)),
      deadlineAt,
      () => this.abandonStartup(epoch),
    );
  }

  /** One lifecycle entry owns one wall-clock budget across authority and socket work. */
  private lifecycleDeadline(): number {
    const now = Date.now();
    return Number.isFinite(now) ? now + this.config.timeoutMs : 0;
  }
  private remaining(deadlineAt: number): number {
    const value = deadlineAt - Date.now();
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }
  private expired(deadlineAt: number): boolean { return this.remaining(deadlineAt) <= 0; }
  /** Reserve one quarter (at most 250 ms) of a lifecycle for priority rollback. */
  private startupWorkDeadline(deadlineAt: number): number {
    const reserve = Math.min(250, Math.max(1, Math.floor(this.config.timeoutMs / 4)));
    return deadlineAt - reserve;
  }
  /** The queued work remains serialized after the caller budget expires. */
  private async settleByDeadline(work: Promise<void>, deadlineAt: number, onExpiry?: () => void): Promise<void> {
    const remaining = this.remaining(deadlineAt);
    if (remaining <= 0) { onExpiry?.(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    try {
      await Promise.race([work.catch(() => {}), new Promise<void>((resolve) => {
        timer = setTimeout(() => { expired = true; resolve(); }, remaining);
        timer.unref?.();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
      if (expired) onExpiry?.();
    }
  }

  private async statusBeforeDeadline(deadlineAt: number) {
    const remaining = this.remaining(deadlineAt);
    if (remaining <= 0) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([officialHookStatus(), new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), remaining);
        timer.unref?.();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private transition(work: () => Promise<void>): Promise<void> {
    const next = this.transitions.then(work, work);
    this.transitions = next.catch(() => {});
    return next;
  }

  /** Coalesce detached replacement starts so a hung probe retains only the latest epoch. */
  private queueStartup(work: () => Promise<void>): Promise<void> {
    return new Promise((resolve) => {
      const replaced = this.queuedStartup;
      this.queuedStartup = { work, resolve };
      // Superseded callers have no ownership to await; their epoch is already fenced.
      replaced?.resolve();
      if (!this.startupRunner) {
        this.startupRunner = this.drainStartups().finally(() => { this.startupRunner = null; });
      }
    });
  }

  private async drainStartups() {
    while (this.queuedStartup) {
      const startup = this.queuedStartup;
      this.queuedStartup = null;
      await processCoordinator.enqueueAuthority(() => this.transition(startup.work));
      startup.resolve();
    }
  }

  private async beginSession(context: unknown, event: unknown, epoch: number, current: RuntimeSession | null, deadlineAt: number) {
    const startupDeadlineAt = this.startupWorkDeadline(deadlineAt);
    await this.teardown(deadlineAt);
    if (epoch !== this.epoch || this.expired(startupDeadlineAt)) { this.abandonStartup(epoch); return; }
    if ((context as { mode?: unknown })?.mode !== "tui") { this.abandonStartup(epoch); return; }
    const identity = readHerdrIdentity();
    // Use the session_start snapshot, not a potentially mutated manager read
    // after asynchronous authority probing.
    if (!identity || !current) { this.abandonStartup(epoch); return; }
    let mode: PresenceMode = "disabled";
    try {
      const status = await this.statusBeforeDeadline(startupDeadlineAt);
      if (status === undefined) { this.abandonStartup(epoch); return; }
      mode = resolvePresenceMode(this.config, status);
    } catch {}
    if (epoch !== this.epoch || this.expired(startupDeadlineAt)) { this.abandonStartup(epoch); return; }
    if (mode === "disabled") { this.abandonStartup(epoch); return; }
    let client: PresenceClient;
    let consumer: ReturnType<typeof createPresenceConsumer>;
    try {
      client = new PresenceClient(identity, new HerdrSocketTransport(identity.socketPath, this.config.timeoutMs, this.config.maxQueue), this.config, mode);
      consumer = createPresenceConsumer({ id: "pi-herdr-presence" });
    } catch { this.abandonStartup(epoch); return; }
    if (!consumer) { this.abandonStartup(epoch); return; }
    // A consumer activation is the ownership acquisition point. Keep this
    // unowned client local until activation succeeds so a failed contender
    // cannot emit startup or teardown traffic for the pane.
    this.consumer = consumer;
    this.mode = mode;
    this.consumerReady = consumer.ready;
    this.sessionId = current.id;
    this.sessionRef = current.ref;
    this.context = context as ContextUsageProvider;
    // Ownership is the session_start manager identity plus its canonical ID,
    // not the short-lived ExtensionContext wrapper supplied to each callback.
    this.sessionManager = current.manager;
    this.ownerEpoch = epoch;
    this.generation = this.generation >= MAX_INTEGER ? 0 : this.generation + 1;
    this.sequence = 0;
    this.terminalEventId = 0;
    this.states.clear();
    this.terminalRecords = [];
    this.terminalTombstones.clear();
    this.terminalOverflow = 0;
    this.rootSession = true;
    this.active = false;
    this.inputLifecycleActive = false;
    // A native prompt can arrive while the asynchronous ownership probe is
    // pending. Its pending record is identity- and epoch-fenced above; adopt
    // only the exact record captured for this now-active TUI session.
    const pendingNativePrompt = this.pendingLifecycle?.epoch === epoch
      && this.pendingLifecycle.id === current.id
      && this.pendingLifecycle.manager === current.manager
      && this.pendingLifecycle.nativePromptWaiting;
    const pendingNativePromptAcceptedAt = pendingNativePrompt ? this.pendingLifecycle?.nativePromptAcceptedAt ?? undefined : undefined;
    this.nativePromptEpoch = pendingNativePrompt ? epoch : null;
    this.resetInputNotificationState();
    this.turn = 0;
    this.toolFailed = false;
    this.terminal = "success";
    this.usage = new UsageTracker();
    this.lastPiState = null;
    this.lastTodoState = null;
    this.clearFailureArrivals();
    this.clearPendingNotifications();
    this.initialProjectionInFlight = false;
    this.initialProjectionDirty = false;

    // Activation synchronously replays retained producer state. Open ingress only
    // for this epoch before activation so replay reaches the reducer; a failed
    // registration is immediately rolled back by teardown below.
    this.ingressEpoch = epoch;
    this.consumerActive = true;
    let activated = false;
    this.activationReplay = true;
    try {
      activated = consumer.activate((name, ready) => { try { this.pi.events.emit(name, ready); } catch {} }) === true;
    } catch { activated = false; } finally { this.activationReplay = false; }
    if (!activated || epoch !== this.epoch || this.consumer !== consumer || this.consumerReady !== consumer.ready) {
      this.teardownLocal();
      this.discardPendingLifecycle(epoch);
      return;
    }
    // A pending native edge becomes live only after this exact consumer owns
    // the TUI session. It can then drive companion state and one deferred toast.
    if (this.nativePromptWaiting()) {
      this.syncCompanionBlocked();
      // Native input has no V2 state record. Preserve its original acceptance
      // position beside live V2 candidates until startup output opens.
      if (pendingNativePromptAcceptedAt !== undefined) this.appendPendingNotification({ kind: "input", acceptedAt: pendingNativePromptAcceptedAt });
    }
    // Claim only after this lane has retired this runtime's prior authority and
    // activation succeeded. A later stale teardown sees a different generation
    // and closes locally without sending pane cleanup for this new owner.
    if (mode === "standalone") this.authorityGeneration = processCoordinator.claimAuthority();
    this.client = client;
    try {
      // Standalone clears current/legacy ownership before restoring authority;
      // companion clears only its separately-owned presentation/token projection.
      await client.prepareSessionAuthority(startupDeadlineAt);
      if (epoch !== this.epoch || this.client !== client || !this.consumerActive) { this.abandonStartup(epoch); return; }
      if (this.expired(startupDeadlineAt)) { this.abandonStartup(epoch); await this.teardown(deadlineAt); return; }
      if (mode === "standalone") await client.reportSession(current.ref, typeof (event as { reason?: unknown })?.reason === "string" ? (event as { reason: string }).reason : undefined, startupDeadlineAt);
    } catch {
      // Lifecycle output is observer-only; buffered retained state still gets
      // one quiet render after bounded cleanup and session attempts settle.
    }
    if (epoch !== this.epoch || this.client !== client || !this.consumerActive) { this.abandonStartup(epoch); return; }
    if (this.expired(startupDeadlineAt)) { this.abandonStartup(epoch); await this.teardown(deadlineAt); return; }

    // Retained replay only reconstructs state. Keep public output closed while
    // the internal startup path awaits report + metadata, so live ingress cannot
    // race a stale initial projection into the socket queue.
    this.initialProjectionInFlight = true;
    let stabilized = false;
    for (let pass = 0; pass < MAX_STARTUP_PROJECTION_PASSES; pass += 1) {
      // Clear immediately before every await: ingress during that pass requires
      // another complete snapshot, while the public output gate remains closed.
      this.initialProjectionDirty = false;
      await this.renderCurrent(true, startupDeadlineAt);
      if (epoch !== this.epoch || this.client !== client || !this.consumerActive) { this.abandonStartup(epoch); return; }
      if (this.expired(startupDeadlineAt)) { this.abandonStartup(epoch); await this.teardown(deadlineAt); return; }
      if (!this.initialProjectionDirty) { stabilized = true; break; }
    }
    if (!stabilized) {
      // Do not publish a projection known to have been superseded. Fence ingress
      // synchronously, then retire this runtime's client and consumer ownership.
      this.ingressEpoch = null;
      this.outputReady = false;
      this.discardPendingLifecycle(epoch);
      await this.teardown(deadlineAt);
      return;
    }
    if (this.expired(startupDeadlineAt)) { this.abandonStartup(epoch); await this.teardown(deadlineAt); return; }
    // No await may separate the clean-pass check from this release.
    this.outputReady = true;
    this.initialProjectionInFlight = false;
    // Retained terminals get their normal bounded metadata lifetime, but never a toast.
    this.scheduleTerminalClear();
    // Consumer activation may synchronously replay retained V2 state. It is
    // projected above, but never promoted into a visible notification. Live
    // edges accepted only after activate() returned drain once, in arrival order.
    this.drainPendingNotifications();
    if (epoch !== this.epoch || this.client !== client || !this.consumerActive) return;
    // These producer activations and deferred lifecycle reductions synchronously
    // enqueue their pane output. Keep the observer-only workspace eligibility
    // probe after them: a stalled pane.list must never delay local ownership.
    this.activateLocalCandidates();
    this.updateContextUsage();
    const pending = this.pendingLifecycle?.epoch === epoch && this.pendingLifecycle.id === current.id && this.pendingLifecycle.manager === current.manager ? this.pendingLifecycle : null;
    this.discardPendingLifecycle(epoch);
    const pendingAgentStart = !!pending && !pending.overflow && pending.edges.some(edge => edge.kind === "agent_start");
    if (pending) this.replayPendingLifecycle(pending);
    // The replay's agent_start has synchronously enqueued its final pane state.
    // Keep its early return, but do not let the observer-only lease overtake it.
    if (pendingAgentStart) {
      if (this.config.metadata) void this.workspaceLease.start();
      return;
    }
    let reloadActive = false;
    try { reloadActive = (context as { isIdle?: () => boolean }).isIdle?.() === false; } catch {}
    if (reloadActive) {
      this.active = true;
      this.turn += 1;
      this.startLongRunningTimer();
      this.publish("running");
    } else this.publish("idle");
    // Never await the observer-only lease. Its pane.list round trip is bounded
    // and independently fenced by replacement/shutdown, and begins only after
    // the final local pane state has entered the transport queue.
    if (this.config.metadata) void this.workspaceLease.start();
  }

  /** All V2 ingress passes through the shared consumer; no local parser or reducer is authoritative. */
  handlePresenceEvent(name: unknown, payload: unknown) {
    try {
      const accepted = this.isIngressOpen() && this.consumerActive ? this.consumer?.accept(name, payload) : undefined;
      if (accepted) this.accept(accepted);
    } catch {}
  }

  /** Ready is an opaque capability: structurally valid clones are deliberately not receipts. */
  handleConsumerReady(payload: unknown) {
    if (!this.isIngressOpen() || !this.rootSession || !this.consumerActive || !this.consumer || !this.consumerReady || payload !== this.consumerReady || this.consumer.ready !== this.consumerReady) return;
    this.activateLocalCandidates();
  }

  /** Native prompts retain only a boolean, first in the exact pending TUI record and then in its active epoch. */
  handleUiPromptStart(context: unknown) {
    if (!isTuiCallback(context)) return;
    const fence = this.activeSessionFence(context);
    if (fence) {
      if (this.nativePromptEpoch === fence.epoch) return;
      this.nativePromptEpoch = fence.epoch;
      this.syncNativePromptState(true, this.nextNotificationAcceptanceTime());
      return;
    }
    const pending = this.pendingSession(context);
    if (pending && !pending.nativePromptWaiting) {
      pending.nativePromptWaiting = true;
      pending.nativePromptAcceptedAt = this.nextNotificationAcceptanceTime();
    }
  }

  handleUiPromptEnd(context: unknown) {
    if (!isTuiCallback(context)) return;
    const fence = this.activeSessionFence(context);
    if (fence) {
      if (this.nativePromptEpoch !== fence.epoch) return;
      this.nativePromptEpoch = null;
      this.syncNativePromptState();
      return;
    }
    const pending = this.pendingSession(context);
    if (pending) { pending.nativePromptWaiting = false; pending.nativePromptAcceptedAt = null; }
  }

  private accept(event: PresenceEventV2) {
    // activate() synchronously replays retained producer state and ready. Once
    // it returns, accepted events are live even though authority output may
    // still be awaiting socket work.
    const deferLiveNotification = !this.activationReplay && this.consumerActive && (!this.outputReady || this.initialProjectionInFlight);
    if (deferLiveNotification && this.initialProjectionInFlight) this.initialProjectionDirty = true;
    if ("state" in event) {
      // A neutral state is a same-source semantic exit: a later external
      // failure or block must be allowed to create a fresh attention edge.
      if (!event.attention) this.externalAttention.remove(event.source);
      this.states.set(event.source, event);
      this.syncCompanionBlocked();
      const inputPresent = this.inputWaiting();
      const acceptedAt = !this.activationReplay && this.consumerActive ? this.nextNotificationAcceptanceTime() : 0;
      // Retained activation replay is state reconstruction, never an alert.
      if (!this.outputReady || deferLiveNotification) {
        if (deferLiveNotification) this.appendPendingNotification({ kind: "state", event, inputPresent, acceptedAt });
        return;
      }
      this.render(event, acceptedAt);
      this.syncInputNotification(isLiveInputRequest(event), inputPresent, acceptedAt);
      return;
    }
    if ("eventId" in event) {
      if (!this.recordTerminal(event, this.outputReady)) return;
      // A terminal replay can populate the fixed token batch but never toast.
      if (!this.outputReady || deferLiveNotification) {
        if (deferLiveNotification) this.appendPendingNotification({ kind: "terminal", event, acceptedAt: this.nextNotificationAcceptanceTime() });
        return;
      }
      this.dispatchTerminal(event);
      return;
    }
    this.states.delete(event.source);
    this.externalAttention.remove(event.source);
    this.syncCompanionBlocked();
    const inputPresent = this.inputWaiting();
    if (!this.outputReady || deferLiveNotification) {
      if (deferLiveNotification) this.appendPendingNotification({ kind: "withdraw", inputPresent, acceptedAt: this.nextNotificationAcceptanceTime() });
      return;
    }
    this.render();
    this.syncInputNotification();
  }

  /**
   * ExtensionContext is a per-event wrapper. Accept only wrappers that expose
   * the session_start manager and its canonical ID in the current runtime epoch.
   */
  private activeSessionFence(context: unknown): { epoch: number; context: ContextUsageProvider } | undefined {
    const current = session(context);
    if (!this.isIngressOpen() || !this.rootSession || this.ownerEpoch !== this.epoch || current === null || current.manager !== this.sessionManager || current.id !== this.sessionId) return undefined;
    return { epoch: this.epoch, context: context as ContextUsageProvider };
  }
  private pendingSession(context: unknown): PendingLifecycle | undefined {
    const current = session(context);
    const pending = this.pendingLifecycle;
    if (!pending || pending.epoch !== this.epoch || !current || current.manager !== pending.manager || current.id !== pending.id) return undefined;
    // Retain a usable provider for deferred replay, never as an ownership fence.
    pending.context = context as ContextUsageProvider;
    return pending;
  }
  /**
   * Pi can emit session_shutdown after /fork mutates the active manager's ID.
   * Shutdown therefore owns the captured manager/epoch, while ordinary
   * callbacks remain fenced to that manager's original ID.
   */
  private shutdownSessionFence(context: unknown): boolean {
    const manager = sessionManager(context);
    return this.rootSession
      && this.ownerEpoch === this.epoch
      && manager !== null
      && manager === this.sessionManager;
  }
  /** A detached startup has the same manager/epoch ownership rule. */
  private pendingShutdownFence(context: unknown): boolean {
    const pending = this.pendingLifecycle;
    const manager = sessionManager(context);
    return pending !== null
      && pending.epoch === this.epoch
      && manager !== null
      && manager === pending.manager;
  }
  private isIngressOpen(): boolean { return this.ingressEpoch === this.epoch; }
  private canOutput(): boolean { return this.isIngressOpen() && this.rootSession && this.consumerActive && this.outputReady; }
  private nativePromptWaiting(): boolean { return this.nativePromptEpoch === this.epoch && this.rootSession && this.ownerEpoch === this.epoch; }
  private inputWaiting(): boolean { return this.nativePromptWaiting() || [...this.states.values()].some(isInteractionWaiting); }
  private syncNativePromptState(liveInput = false, acceptedAt?: number) {
    this.syncCompanionBlocked();
    if (this.initialProjectionInFlight) this.initialProjectionDirty = true;
    if (!this.outputReady) {
      // Unlike retained replay, native UI edges are live. Keep their exact
      // startup order with V2 candidates instead of promoting them early.
      if (this.consumerActive && !this.activationReplay) {
        if (liveInput && acceptedAt !== undefined) this.appendPendingNotification({ kind: "input", acceptedAt });
        else this.appendPendingNotification({ kind: "withdraw", inputPresent: this.inputWaiting(), acceptedAt: this.nextNotificationAcceptanceTime() });
      }
      return;
    }
    this.render();
    this.syncInputNotification(liveInput, this.inputWaiting(), acceptedAt);
  }
  private discardPendingLifecycle(epoch: number) { if (this.pendingLifecycle?.epoch === epoch) this.pendingLifecycle = null; }
  private abandonStartup(epoch: number) { this.discardPendingLifecycle(epoch); }
  private hasActiveSessionContext(context: unknown): context is ContextUsageProvider { return this.activeSessionFence(context) !== undefined; }
  private isActiveSessionFence(fence: { epoch: number; context: ContextUsageProvider }): boolean {
    return this.epoch === fence.epoch && this.hasActiveSessionContext(fence.context);
  }
  /** Never coalesce edges: retain exact order to capacity, then drop the whole sequence and fail closed. */
  private appendPendingLifecycle(pending: PendingLifecycle, edge: PendingLifecycleEdge) {
    if (pending.overflow) return;
    if (pending.edges.length >= MAX_PENDING_LIFECYCLE_EDGES) { pending.edges = []; pending.overflow = true; return; }
    pending.edges.push(edge);
  }

  /** Preserve only a bounded exact-order live notification sequence during startup. */
  private appendPendingNotification(candidate: PendingNotificationCandidate) {
    if (this.pendingNotificationsOverflow) return;
    if (this.pendingNotifications.length >= MAX_PENDING_NOTIFICATION_CANDIDATES) {
      this.pendingNotifications = [];
      this.pendingNotificationsOverflow = true;
      return;
    }
    this.pendingNotifications.push(candidate);
  }

  /** Startup state/metadata has already rendered; drain policy-only edges without rendering again. */
  private drainPendingNotifications() {
    const pending = this.pendingNotifications;
    const overflow = this.pendingNotificationsOverflow;
    this.clearPendingNotifications();
    if (overflow || !this.canOutput()) return;
    // Startup edges can wait on socket work longer than the pairing window. Pair
    // only their original acceptance times, never a delayed drain timestamp.
    const paired = new Set<PendingNotificationCandidate>();
    const deferredFailures = new Map<PendingNotificationCandidate, Extract<PendingNotificationCandidate, { kind: "state" }>[] >();
    const deferredFailureCandidates = new Set<PendingNotificationCandidate>();
    const isInput = (candidate: PendingNotificationCandidate) => candidate.kind === "input" || (candidate.kind === "state" && isLiveInputRequest(candidate.event));
    for (let index = 0; index < pending.length; index += 1) {
      const state = pending[index]!;
      if (state.kind !== "state" || state.event.attention?.reason !== "failure") continue;
      const terminal = pending.find(candidate => candidate.kind === "terminal"
        && !paired.has(candidate)
        && candidate.event.outcome === "failed"
        && candidate.event.source === state.event.source
        && candidate.event.generation === state.event.generation
        && Math.abs(candidate.acceptedAt - state.acceptedAt) <= FAILURE_PAIR_WINDOW_MS);
      if (terminal) { paired.add(state); paired.add(terminal); continue; }
      // A failure before an input waits only until that exact input candidate is
      // attempted. A rejected candidate falls back to the normal failure alert.
      const input = pending.slice(index + 1).find(candidate => isInput(candidate)
        && Math.abs(candidate.acceptedAt - state.acceptedAt) <= FAILURE_PAIR_WINDOW_MS);
      if (input) {
        deferredFailureCandidates.add(state);
        deferredFailures.set(input, [...(deferredFailures.get(input) ?? []), state]);
      }
    }
    let startupInputLifecycleActive = false;
    let startupInputAttempted = false;
    const lifecycleForInput = new Map<PendingNotificationCandidate, number>();
    for (const candidate of pending) {
      if (!this.canOutput()) return;
      if (isInput(candidate)) {
        if (!startupInputLifecycleActive) {
          // Native and V2 overlap remains one aggregate lifecycle, but every
          // new lifecycle receives a distinct admission receipt.
          startupInputLifecycleActive = true;
          const lifecycle = this.beginInputLifecycle(candidate.acceptedAt);
          lifecycleForInput.set(candidate, lifecycle.id);
          this.dispatchPendingStartupInput(lifecycle.id);
          startupInputAttempted = true;
        } else if (this.currentInputLifecycleId !== null) lifecycleForInput.set(candidate, this.currentInputLifecycleId);
        // Deferred failures skip their original accepted slot and are decided
        // only after this exact bounded input attempt has an admission receipt.
        for (const failure of deferredFailures.get(candidate) ?? []) {
          const lifecycleId = lifecycleForInput.get(candidate);
          this.dispatchStateAttention(failure.event, false, true, failure.acceptedAt, lifecycleId);
        }
        continue;
      }
      if (candidate.kind === "terminal") this.dispatchTerminal(candidate.event, false);
      else if (candidate.kind === "state") {
        if (!paired.has(candidate) && !deferredFailureCandidates.has(candidate)) {
          // An input may already have ended in this startup sequence. Resolve
          // the failure against that most-recent receipt exactly as the live
          // pairing timer does, so an older admitted lifecycle cannot mask a
          // newer rejected one.
          const inputLifecycleId = this.associatedInputLifecycle(candidate.acceptedAt)
            ?? this.recentInputLifecycleForFailure(candidate.acceptedAt);
          this.dispatchStateAttention(candidate.event, false, true, candidate.acceptedAt, inputLifecycleId);
        }
        if (!candidate.inputPresent) {
          startupInputLifecycleActive = false;
          this.endInputLifecycle(candidate.acceptedAt);
        }
      } else if (candidate.kind === "withdraw" && !candidate.inputPresent) {
        startupInputLifecycleActive = false;
        this.endInputLifecycle(candidate.acceptedAt);
      }
    }
    // Keep the aggregate lifecycle live after its startup candidate drains so
    // a native/V2 overlap cannot be mistaken for a new lifecycle. Retained
    // replay has no candidate and remains quiet until a live input edge arrives.
    this.inputLifecycleActive = this.inputWaiting();
    if (this.inputLifecycleActive && this.currentInputLifecycleId === null)
      this.beginInputLifecycle(this.nextNotificationAcceptanceTime());
    if (!this.inputLifecycleActive) this.endInputLifecycle(this.nextNotificationAcceptanceTime());
    this.inputNotificationPending = false;
    this.inputNotificationAttempted = this.inputLifecycleActive && startupInputAttempted;
  }

  private nextNotificationAcceptanceTime(): number {
    // Wall-clock time can be frozen or adjusted while startup is blocked. This
    // is internal-only, so retain the full safe monotonic millisecond value;
    // protocol MAX_INTEGER applies only to wire ordinals.
    const now = this.notificationClock();
    if (Number.isSafeInteger(now) && now >= 0) this.notificationAcceptanceTime = Math.max(this.notificationAcceptanceTime, now);
    return this.notificationAcceptanceTime;
  }

  private clearPendingNotifications() {
    this.pendingNotifications = [];
    this.pendingNotificationsOverflow = false;
  }

  handleAgentStart(context: unknown) {
    if (!this.outputReady || !this.consumerActive || !this.hasActiveSessionContext(context)) {
      const pending = this.pendingSession(context);
      if (pending) this.appendPendingLifecycle(pending, { kind: "agent_start" });
      return;
    }
    this.startActiveAgent(context as ContextUsageProvider);
  }

  private startActiveAgent(context: ContextUsageProvider) {
    this.activateLocalCandidates();
    this.context = context;
    const client = this.client;
    const ref = this.sessionRef;
    const epoch = this.epoch;
    if (this.mode === "standalone" && client && ref) void client.reportSession(ref).then(() => { if (epoch !== this.epoch || this.client !== client) return; }).catch(() => {});
    // Each agent_start starts a fresh reducer turn even when detached edges
    // are replayed after a previous turn already settled.
    this.terminal = "success";
    this.toolFailed = false;
    if (!this.active) {
      this.active = true;
      this.turn += 1;
      this.usage = new UsageTracker();
      this.startLongRunningTimer();
    }
    this.updateContextUsage();
    this.publish("running");
  }

  handleTurnStart(context: unknown) {
    if (!this.outputReady || !this.hasActiveSessionContext(context)) {
      const pending = this.pendingSession(context);
      if (pending) this.appendPendingLifecycle(pending, { kind: "turn_start", contextPercent: deriveContextPercent(pending.context) });
      return;
    }
    this.context = context;
    this.updateContextUsage();
  }

  handleAgentEnd(event: unknown, context: unknown) {
    if (!this.outputReady || !this.hasActiveSessionContext(context)) {
      const pending = this.pendingSession(context);
      if (pending) this.appendPendingLifecycle(pending, { kind: "agent_end", terminal: deriveExplicitTerminal(event) });
      return;
    }
    this.terminal = deriveTerminalState(event, this.toolFailed);
  }

  handleAgentSettled(context: unknown) {
    const fence = this.outputReady ? this.activeSessionFence(context) : undefined;
    if (!fence) {
      const pending = this.pendingSession(context);
      if (!pending) return;
      try { if (pending.context.isIdle?.() === false) return; } catch { return; }
      this.appendPendingLifecycle(pending, { kind: "agent_settled" });
      return;
    }
    try {
      const idle = fence.context.isIdle;
      if (idle && idle() === false) return;
    } catch { return; }
    this.settleActiveAgent(fence);
  }


  /** Emit one terminal state/event pair only while the captured lifecycle still owns this session. */
  private settleActiveAgent(fence: { epoch: number; context: ContextUsageProvider }) {
    if (!this.consumerActive || !this.active || !this.isActiveSessionFence(fence)) return;
    this.activateLocalCandidates();
    if (!this.active || !this.isActiveSessionFence(fence)) return;
    this.active = false;
    this.clearLongRunningTimer();
    this.updateContextUsage();
    // A settlement emits a state and a terminal, so reserve both before either can consume the final ordinal.
    if (this.reserveLocalOrdinals(2, true)) {
      const stateOrdinal = this.consumeLocalOrdinal();
      const terminalOrdinal = this.consumeLocalOrdinal();
      if (stateOrdinal && terminalOrdinal) {
        this.publishPi(this.terminal, stateOrdinal);
        if (this.localPiActive && this.localPi && this.terminalEventId < MAX_INTEGER) {
          this.terminalEventId += 1;
          this.localPi.publishTerminal({ version: 2, generation: terminalOrdinal.generation, sequence: terminalOrdinal.sequence, source: "pi", eventId: this.terminalEventId, outcome: this.terminal === "error" ? "failed" : this.terminal === "cancelled" ? "cancelled" : "completed" });
        }
      }
    }
  }

  handleMessageEnd(event: unknown, context: unknown) {
    if (!this.outputReady || !this.hasActiveSessionContext(context)) {
      const pending = this.pendingSession(context);
      const usage = deriveUsage(event);
      if (pending && usage) this.appendPendingLifecycle(pending, { kind: "message_end", usage });
      return;
    }
    const usage = deriveUsage(event);
    if (usage) {
      this.usage.add(usage);
      this.updateContextUsage();
      this.render();
    }
  }

  handleToolResult(event: unknown, context: unknown) {
    if (!this.outputReady || !this.hasActiveSessionContext(context)) {
      const pending = this.pendingSession(context);
      if (pending) this.appendPendingLifecycle(pending, this.derivePendingTool(event));
      return;
    }
    this.applyToolResult(event);
  }

  /** Reduce a detached tool payload immediately to error/count state before retaining it. */
  private derivePendingTool(event: unknown): PendingLifecycleEdge {
    const failed = (event as { isError?: unknown })?.isError === true;
    let todo: PresenceStateInputV2 | null = null;
    try { todo = this.todo.accept(event, this.pi.getAllTools(), 0, 0); } catch {}
    return { kind: "tool_result", failed, ...(todo ? { todo: { state: todo.state, ...(todo.progress ? { progress: todo.progress } : {}) } } : {}) };
  }
  private applyToolResult(event: unknown) {
    if ((event as { isError?: unknown })?.isError === true && this.active) this.toolFailed = true;
    this.activateLocalCandidates();
    const ordinal = this.nextLocalOrdinal();
    if (!ordinal) return;
    let todo: PresenceStateInputV2 | null = null;
    try { todo = this.todo.accept(event, this.pi.getAllTools(), ordinal.generation, ordinal.sequence); } catch {}
    if (todo) this.publishTodo(todo);
  }
  private applyDerivedTool(edge: Extract<PendingLifecycleEdge, { kind: "tool_result" }>) {
    if (edge.failed && this.active) this.toolFailed = true;
    this.activateLocalCandidates();
    const ordinal = this.nextLocalOrdinal();
    if (ordinal && edge.todo) this.publishTodo({ version: 2, generation: ordinal.generation, sequence: ordinal.sequence, source: "todo", ...edge.todo });
  }
  private replayPendingLifecycle(pending: PendingLifecycle) {
    if (pending.overflow) return;
    const fence = this.activeSessionFence(pending.context);
    if (!fence) return;
    for (const edge of pending.edges) {
      if (!this.isActiveSessionFence(fence)) return;
      switch (edge.kind) {
        case "agent_start": this.startActiveAgent(pending.context); break;
        case "turn_start": if (edge.contextPercent !== undefined) this.usage.setContext({ contextPercent: edge.contextPercent }); break;
        case "agent_end": this.terminal = edge.terminal ?? (this.toolFailed ? "error" : "success"); break;
        case "agent_settled": this.settleActiveAgent(fence); break;
        case "message_end": this.usage.add(edge.usage); this.updateContextUsage(); this.render(); break;
        case "tool_result": this.applyDerivedTool(edge); break;
      }
    }
  }

  async shutdownSession(context: object) {
    const deadlineAt = this.lifecycleDeadline();
    // An unfenced shutdown could tear down a replacement session. Unlike
    // ordinary callbacks, /fork may mutate the legitimate owner's ID before
    // Pi emits shutdown, so this fence intentionally checks manager + epoch.
    if (!this.shutdownSessionFence(context) && !this.pendingShutdownFence(context)) return;
    // Fence and abort observer eligibility before queued lifecycle teardown.
    this.releaseCompanionBlocked();
    this.nativePromptEpoch = null;
    this.client?.fenceOrdinaryOutput();
    this.workspaceLease.stop();
    ++this.epoch;
    this.ingressEpoch = null;
    this.outputReady = false;
    this.pendingLifecycle = null;
    this.clearPendingNotifications();
    this.resetInputNotificationState();
    this.clearInputLifecycles();
    this.clearExternalAttention();
    this.clearFailureArrivals();
    // Reserve this teardown synchronously. A cache-busted replacement can queue
    // startup immediately afterwards, but cannot acquire authority before this
    // client's bounded remote cleanup has completed.
    const cleanup = processCoordinator.enqueueAuthority(() => this.transition(() => this.teardown(deadlineAt)));
    return this.settleByDeadline(cleanup, deadlineAt);
  }

  private publish(state: "idle" | "running") {
    if (!this.rootSession) return;
    const ordinal = this.nextLocalOrdinal();
    if (ordinal) this.publishPi(state, ordinal);
  }

  private publishPi(state: PresenceStateInputV2["state"], ordinal: { generation: number; sequence: number }) {
    const base = { version: 2 as const, generation: ordinal.generation, sequence: ordinal.sequence, source: "pi" as const };
    const snapshot: PresenceStateInputV2 = state === "error"
      ? { ...base, state, attention: { reason: "failure", occurrence: "new" } }
      : { ...base, state };
    this.lastPiState = snapshot;
    if (this.localPiActive) this.localPi?.publishState(snapshot);
  }

  private publishTodo(snapshot: PresenceStateInputV2) {
    this.lastTodoState = snapshot;
    if (this.localTodoActive) this.localTodo?.publishState(snapshot);
  }

  /** Reserve output slots plus enough room to withdraw every source we currently own at generation max. */
  private reserveLocalOrdinals(slots: number, terminal = false): boolean {
    if (slots < 1 || slots > MAX_INTEGER) return false;
    const owners = this.localOwnerCount();
    const enough = this.sequence + slots <= MAX_INTEGER
      && (!terminal || this.terminalEventId < MAX_INTEGER)
      && (this.generation < MAX_INTEGER || this.sequence + slots + owners <= MAX_INTEGER);
    if (enough) return true;
    if (this.generation < MAX_INTEGER) {
      this.generation += 1;
      this.sequence = 0;
      this.terminalEventId = 0;
      return true;
    }
    return this.rotateLocalSources();
  }

  private consumeLocalOrdinal(): { generation: number; sequence: number } | undefined {
    if (this.sequence >= MAX_INTEGER) return undefined;
    this.sequence += 1;
    return { generation: this.generation, sequence: this.sequence };
  }

  private nextLocalOrdinal(): { generation: number; sequence: number } | undefined {
    return this.reserveLocalOrdinals(1) ? this.consumeLocalOrdinal() : undefined;
  }

  private localOwnerCount(): number { return Number(this.localPiActive) + Number(this.localTodoActive); }

  /** At the generation ceiling, withdraw owned retained sources before discarding their producer fences. */
  private rotateLocalSources(): boolean {
    const owners = this.localOwnerCount();
    if (this.sequence + owners > MAX_INTEGER) return false;
    this.withdrawAndDeactivateLocalSources();
    this.localPi = null;
    this.localTodo = null;
    this.localPiActive = false;
    this.localTodoActive = false;
    this.generation = 0;
    this.sequence = 0;
    this.terminalEventId = 0;
    this.rotationPending = true;
    this.activateLocalCandidates();
    return true;
  }

  /** Use a valid event before deactivation so consumer state cannot survive an owned source rotation. */
  private withdrawAndDeactivateLocalSources() {
    const owners = this.localOwnerCount();
    // Teardown can occur between ordinary publications; advance once when that is enough to retain valid withdrawal ordinals.
    if (owners > 0 && this.sequence + owners > MAX_INTEGER && this.generation < MAX_INTEGER) {
      this.generation += 1;
      this.sequence = 0;
      this.terminalEventId = 0;
    }
    if (this.localPiActive && this.localPi) {
      const ordinal = this.consumeLocalOrdinal();
      if (ordinal) this.localPi.withdraw({ version: 2, generation: ordinal.generation, sequence: ordinal.sequence, source: "pi" });
      this.localPi.deactivate();
    }
    if (this.localTodoActive && this.localTodo) {
      const ordinal = this.consumeLocalOrdinal();
      if (ordinal) this.localTodo.withdraw({ version: 2, generation: ordinal.generation, sequence: ordinal.sequence, source: "todo" });
      this.localTodo.deactivate();
    }
    this.localPiActive = false;
    this.localTodoActive = false;
  }

  /** Bridge aggregate native-or-V2 input waiting into Herdr's managed counter only. */
  private syncCompanionBlocked() {
    if (this.mode !== "companion") return;
    const active = this.inputWaiting();
    if (active === this.companionBlocked) return;
    this.companionBlocked = active;
    try {
      this.pi.events.emit("herdr:blocked", active ? { active: true, label: "Pi needs your input" } : { active: false });
    } catch {}
  }

  /** A synchronous lifecycle fence must balance a prior best-effort acquire. */
  private releaseCompanionBlocked() {
    if (!this.companionBlocked) return;
    this.companionBlocked = false;
    try { this.pi.events.emit("herdr:blocked", { active: false }); } catch {}
  }

  /** One live input lifecycle yields at most one alert; retained replay only restores pane state. */
  private syncInputNotification(liveInput = false, inputPresent = this.inputWaiting(), acceptedAt?: number) {
    const edgeAt = acceptedAt ?? this.nextNotificationAcceptanceTime();
    if (!inputPresent) {
      if (this.inputNotificationPending && !this.inputNotificationAttempted && this.outputReady) this.dispatchPendingInputNotification(edgeAt);
      this.endInputLifecycle(edgeAt);
      this.resetInputNotificationState();
      return;
    }
    if (!this.inputLifecycleActive) {
      this.inputLifecycleActive = true;
      this.beginInputLifecycle(edgeAt);
    }
    if (this.inputNotificationAttempted) return;
    if (liveInput) this.inputNotificationPending = true;
    if (!this.inputNotificationPending || !this.outputReady) return;
    this.dispatchPendingInputNotification(edgeAt);
  }

  /** Input is attempted immediately; only an admitted attempt can suppress its attached failures. */
  private dispatchPendingInputNotification(_acceptedAt: number): boolean {
    if (!this.inputNotificationPending || !this.outputReady) return false;
    this.inputNotificationPending = false;
    this.inputNotificationAttempted = true;
    this.inputNotificationTransitions = Math.min(MAX_NOTIFICATION_TRANSITIONS, this.inputNotificationTransitions + 1);
    this.discardExternalProgress();
    const admitted = this.notify("attention", `input:${this.turn}:${this.inputNotificationTransitions}`, "Pi needs your input", "Pi needs your input", "local");
    this.recordInputAdmission(this.currentInputLifecycleId, admitted);
    return admitted;
  }

  /** Attempt one deferred startup input candidate in acceptance order. */
  private dispatchPendingStartupInput(lifecycleId: number): boolean {
    this.inputNotificationTransitions = Math.min(MAX_NOTIFICATION_TRANSITIONS, this.inputNotificationTransitions + 1);
    this.discardExternalProgress();
    const admitted = this.notify("attention", `input:${this.turn}:${this.inputNotificationTransitions}`, "Pi needs your input", "Pi needs your input", "local");
    this.recordInputAdmission(lifecycleId, admitted);
    return admitted;
  }

  private beginInputLifecycle(acceptedAt: number): InputLifecycle {
    const current = this.inputLifecycle(this.currentInputLifecycleId);
    if (current) return current;
    const lifecycle: InputLifecycle = {
      id: ++this.nextInputLifecycleId,
      acceptedAt,
      attempted: false,
      admitted: false,
    };
    this.inputLifecycles.push(lifecycle);
    this.currentInputLifecycleId = lifecycle.id;
    // A failure that arrived just before this aggregate lifecycle belongs here,
    // rather than to an older lifecycle that happened to end nearby.
    for (const arrival of this.failureArrivals) {
      if (arrival.kind === "state" && arrival.inputLifecycleId === undefined && acceptedAt >= arrival.acceptedAt && acceptedAt - arrival.acceptedAt <= FAILURE_PAIR_WINDOW_MS)
        arrival.inputLifecycleId = lifecycle.id;
    }
    this.purgeInputLifecycles();
    return lifecycle;
  }

  private endInputLifecycle(endedAt: number) {
    const current = this.inputLifecycle(this.currentInputLifecycleId);
    if (current && current.endedAt === undefined) {
      current.endedAt = endedAt;
      current.expiresAt = Date.now() + FAILURE_PAIR_WINDOW_MS;
      current.purgeTimer = setTimeout(() => this.purgeInputLifecycles(), FAILURE_PAIR_WINDOW_MS);
      current.purgeTimer.unref?.();
    }
    this.currentInputLifecycleId = null;
    this.purgeInputLifecycles();
  }

  private inputLifecycle(id: number | null | undefined): InputLifecycle | undefined {
    return id === undefined || id === null ? undefined : this.inputLifecycles.find((lifecycle) => lifecycle.id === id);
  }

  private recordInputAdmission(id: number | null, admitted: boolean) {
    const lifecycle = this.inputLifecycle(id);
    if (!lifecycle) return;
    lifecycle.attempted = true;
    lifecycle.admitted = admitted;
  }

  /** A live failure joins only a currently active aggregate lifecycle. */
  private associatedInputLifecycle(_acceptedAt: number): number | undefined {
    return this.inputLifecycle(this.currentInputLifecycleId)?.id;
  }

  /** A just-ended lifecycle remains eligible only if no newer lifecycle claimed the failure. */
  private recentInputLifecycleForFailure(acceptedAt: number): number | undefined {
    for (let index = this.inputLifecycles.length - 1; index >= 0; index -= 1) {
      const lifecycle = this.inputLifecycles[index]!;
      if (lifecycle.endedAt !== undefined && acceptedAt >= lifecycle.endedAt && acceptedAt - lifecycle.endedAt <= FAILURE_PAIR_WINDOW_MS)
        return lifecycle.id;
    }
    return undefined;
  }

  private failureSuppressedByLifecycle(id: number | undefined): boolean {
    const lifecycle = this.inputLifecycle(id);
    return lifecycle?.attempted === true && lifecycle.admitted;
  }

  private purgeInputLifecycles(now = Date.now()) {
    for (let index = this.inputLifecycles.length - 1; index >= 0; index -= 1) {
      const lifecycle = this.inputLifecycles[index]!;
      const referenced = this.failureArrivals.some((arrival) => arrival.inputLifecycleId === lifecycle.id || (
        arrival.inputLifecycleId === undefined && lifecycle.endedAt !== undefined && arrival.acceptedAt >= lifecycle.endedAt && arrival.acceptedAt - lifecycle.endedAt <= FAILURE_PAIR_WINDOW_MS
      ));
      if (lifecycle.id !== this.currentInputLifecycleId && lifecycle.expiresAt !== undefined && lifecycle.expiresAt <= now && !referenced) {
        if (lifecycle.purgeTimer) clearTimeout(lifecycle.purgeTimer);
        this.inputLifecycles.splice(index, 1);
      }
    }
    // At most one currently active lifecycle can exist in addition to every
    // bounded failure arrival. Never evict a receipt still referenced by one.
    while (this.inputLifecycles.length > MAX_FAILURE_PAIRS + 1) {
      const removable = this.inputLifecycles.findIndex((lifecycle) => lifecycle.id !== this.currentInputLifecycleId && !this.failureArrivals.some((arrival) => arrival.inputLifecycleId === lifecycle.id || (
        arrival.inputLifecycleId === undefined && lifecycle.endedAt !== undefined && arrival.acceptedAt >= lifecycle.endedAt && arrival.acceptedAt - lifecycle.endedAt <= FAILURE_PAIR_WINDOW_MS
      )));
      if (removable < 0) break;
      const [lifecycle] = this.inputLifecycles.splice(removable, 1);
      if (lifecycle?.purgeTimer) clearTimeout(lifecycle.purgeTimer);
    }
  }

  private clearInputLifecycles() {
    for (const lifecycle of this.inputLifecycles) if (lifecycle.purgeTimer) clearTimeout(lifecycle.purgeTimer);
    this.inputLifecycles.length = 0;
    this.currentInputLifecycleId = null;
    this.nextInputLifecycleId = 0;
  }

  private resetInputNotificationState() {
    this.inputLifecycleActive = false;
    this.inputNotificationPending = false;
    this.inputNotificationAttempted = false;
  }

  /** The startup projection is awaited so agent, metadata, then notifications stay ordered. */
  private async renderCurrent(startup = false, deadlineAt?: number) {
    const ref = this.sessionRef;
    const client = this.client;
    const internalStartupOutput = startup && this.initialProjectionInFlight && this.isIngressOpen() && this.rootSession && this.consumerActive;
    if ((!this.canOutput() && !internalStartupOutput) || !ref || !client) return;
    const events = [...this.states.values()];
    const nativePromptWaiting = this.nativePromptWaiting();
    const state = compositeState(events, this.active, nativePromptWaiting);
    const terminals = this.currentTerminalBatch();
    if (this.mode === "standalone") await client.report(state, ref, safeMessage(state, this.config.maxLabelChars, events, this.active, nativePromptWaiting), deadlineAt);
    const tokens = metadata(events, terminals, this.usage.snapshot(), this.active, state, this.latestTerminalOutcome(), nativePromptWaiting);
    this.workspaceLease.update(tokens.summary);
    await client.metadata(presentation(), tokens, deadlineAt);
  }

  private render(attention?: PresenceStateV2, acceptedAt?: number) {
    const ref = this.sessionRef;
    const client = this.client;
    if (!this.canOutput() || !ref || !client) return;
    const events = [...this.states.values()];
    const nativePromptWaiting = this.nativePromptWaiting();
    const state = compositeState(events, this.active, nativePromptWaiting);
    if (this.mode === "standalone") void client.report(state, ref, safeMessage(state, this.config.maxLabelChars, events, this.active, nativePromptWaiting));
    this.renderMetadata(events, client, state);

    this.dispatchStateAttention(attention, true, false, acceptedAt);
  }

  /** Metadata-only refreshes must not repeat an unchanged pane agent report. */
  private renderMetadata(events = [...this.states.values()], client = this.client, state = compositeState(events, this.active, this.nativePromptWaiting())) {
    if (!this.canOutput() || !client) return;
    const tokens = metadata(events, this.currentTerminalBatch(), this.usage.snapshot(), this.active, state, this.latestTerminalOutcome(), this.nativePromptWaiting());
    this.workspaceLease.update(tokens.summary);
    void client.metadata(presentation(), tokens);
  }

  /** Applies one already-accepted live state edge without re-rendering startup state. */
  private dispatchStateAttention(attention?: PresenceStateV2, deferFailure = true, immediateExternal = false, acceptedAt = this.nextNotificationAcceptanceTime(), inputLifecycleId = this.associatedInputLifecycle(acceptedAt)) {
    const text = attention && attentionText(attention, this.config.maxLabelChars);
    const reason = attention?.attention?.reason;
    if (!attention || !text || text.inputNeeded || !reason) return;
    const origin = attention.source === "pi" || attention.source === "todo" ? "local" : "external";
    const attentionKind = reason === "failure" || reason === "blocked" ? "error" : "success";
    const severity = text.error ? "error" : "success";
    if (reason === "failure") {
      if (deferFailure) {
        // Let a same-turn terminal claim the alert, while state-only failures retain
        // their normal policy, coalescing, and rate-limit behavior.
        this.queueStateFailure(attention.source, attention.generation, acceptedAt, inputLifecycleId, () => {
          this.dispatchAttention(attention, attentionKind, severity, text.title, text.body, origin);
        });
        return;
      }
      // A startup edge already waited for its pairing decision. Do not give an
      // unpaired external failure a second coalescing timer that can reorder it.
      if (this.failureSuppressedByLifecycle(inputLifecycleId)) return;
      if (origin === "external") {
        if (this.externalAttention.accept(attention.source, attention.generation, attentionKind)) {
          this.notify(severity, `${attention.source}:${attention.generation}:${attention.sequence}:${this.turn}:${reason}`, text.title, text.body, origin);
        }
        return;
      }
    }
    this.dispatchAttention(attention, attentionKind, severity, text.title, text.body, origin, immediateExternal);
  }

  /** Records each exact terminal identity once, including across reset producer fences. */
  private recordTerminal(event: PresenceTerminalV2, schedule = true): boolean {
    const key = this.terminalIdentity(event);
    const current = this.terminalRecords.find(record => this.terminalIdentity(record) === key);
    const recordedOutcome = this.terminalTombstones.get(key);
    if (current || recordedOutcome !== undefined) {
      // Touch known identities so the bounded registry remains LRU even on replay.
      if (recordedOutcome !== undefined) {
        this.terminalTombstones.delete(key);
        this.terminalTombstones.set(key, recordedOutcome);
      }
      // Both exact replays and conflicting outcomes fail closed without output.
      return false;
    }
    this.terminalTombstones.set(key, event.outcome);
    while (this.terminalTombstones.size > MAX_TERMINAL_TOMBSTONES) {
      const oldest = this.terminalTombstones.keys().next().value;
      if (oldest === undefined) break;
      this.terminalTombstones.delete(oldest);
    }
    if (this.terminalRecords.length >= MAX_TERMINALS) this.omitOldestTerminal();
    this.terminalRecords.push(event);
    this.trimTerminalValue();
    if (schedule) this.scheduleTerminalClear();
    return true;
  }

  private terminalIdentity(event: PresenceTerminalV2): string { return `${event.source}:${event.generation}:${event.eventId}`; }
  private omitOldestTerminal() {
    if (this.terminalRecords.shift()) this.terminalOverflow = Math.min(MAX_TERMINAL_OVERFLOW, this.terminalOverflow + 1);
  }
  /** Keep the newest retained records while using the shared canonical encoder. */
  private trimTerminalValue() {
    while (this.terminalRecords.length > 0) {
      const batch = encodeTerminalBatch(this.terminalRecords, this.terminalOverflow);
      if (Buffer.byteLength(batch.value, "utf8") <= HERDR_TERMINAL_VALUE_MAX_BYTES) return;
      this.omitOldestTerminal();
    }
  }

  /** Terminal alert policy runs after recording so metadata always includes its batch. */
  private dispatchTerminal(event: PresenceTerminalV2, emitMetadata = true) {
    const events = [...this.states.values()];
    const client = this.client;
    // Route terminal metadata through the shared projection so its summary is
    // remembered before the client request and subsequent workspace heartbeat.
    if (emitMetadata && this.rootSession && this.consumerActive && this.outputReady && client) this.renderMetadata(events, client);
    if (!this.outputReady) return;
    // Cancellation remains a quiet display-only terminal summary.
    if (event.outcome === "cancelled") return;
    const severity = event.outcome === "failed" ? "error" : "success";
    const origin = event.source === "pi" ? "local" : "external";
    const key = `terminal:${event.source}:${event.generation}:${event.eventId}`;
    if (severity === "error") {
      this.suppressPairedStateFailure(event.source, event.generation);
      this.discardExternalProgress();
      this.notifyTerminalFailure(key, origin);
      return;
    }
    this.notify(severity, key, "Pi activity completed", "Pi activity completed", origin);
  }

  /** The terminal encoder sorts canonically; summary instead follows accepted arrival order. */
  private latestTerminalOutcome(): PresenceTerminalV2["outcome"] | undefined { return this.terminalRecords.at(-1)?.outcome; }

  /** An absent batch withdraws both terminal metadata tokens with null. */
  private currentTerminalBatch(): TerminalBatch | undefined {
    return this.terminalRecords.length > 0 ? encodeTerminalBatch(this.terminalRecords, this.terminalOverflow) : undefined;
  }

  /** State failures wait only for a synchronous same-generation terminal. */
  private queueStateFailure(source: string, generation: number, acceptedAt: number, inputLifecycleId: number | undefined, notify: () => void) {
    this.purgeFailureArrivals();
    const terminalIndex = this.failureArrivals.findIndex(entry => entry.source === source && entry.generation === generation && entry.kind === "terminal");
    if (terminalIndex >= 0) { this.removeFailureArrival(this.failureArrivals[terminalIndex]!); this.purgeInputLifecycles(); return; }
    const entry: FailureArrival = { source, generation, kind: "state", acceptedAt, expiresAt: Date.now() + FAILURE_PAIR_WINDOW_MS, inputLifecycleId, notify };
    entry.timer = setTimeout(() => this.expireFailureArrival(entry), FAILURE_PAIR_WINDOW_MS);
    entry.timer.unref?.();
    this.rememberFailure(entry);
  }

  /** A terminal never loses its own alert; it only cancels one paired state alert. */
  private suppressPairedStateFailure(source: string, generation: number) {
    this.purgeFailureArrivals();
    const stateIndex = this.failureArrivals.findIndex(entry => entry.source === source && entry.generation === generation && entry.kind === "state");
    if (stateIndex >= 0) { this.removeFailureArrival(this.failureArrivals[stateIndex]!); this.purgeInputLifecycles(); return; }
    const entry: FailureArrival = { source, generation, kind: "terminal", acceptedAt: this.nextNotificationAcceptanceTime(), expiresAt: Date.now() + FAILURE_PAIR_WINDOW_MS };
    entry.timer = setTimeout(() => this.expireFailureArrival(entry), FAILURE_PAIR_WINDOW_MS);
    entry.timer.unref?.();
    this.rememberFailure(entry);
  }

  private expireFailureArrival(entry: FailureArrival) {
    if (!this.removeFailureArrival(entry)) return;
    if (entry.inputLifecycleId === undefined)
      entry.inputLifecycleId = this.recentInputLifecycleForFailure(entry.acceptedAt);
    if (!this.failureSuppressedByLifecycle(entry.inputLifecycleId)) entry.notify?.();
    this.purgeInputLifecycles();
  }
  private removeFailureArrival(entry: FailureArrival): boolean {
    const index = this.failureArrivals.indexOf(entry);
    if (index < 0) return false;
    this.failureArrivals.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    return true;
  }
  /** Expired state entries dispatch rather than silently losing their independent edge. */
  private purgeFailureArrivals(now = Date.now()) {
    for (const entry of [...this.failureArrivals]) {
      if (entry.expiresAt > now || !this.removeFailureArrival(entry)) continue;
      if (entry.inputLifecycleId === undefined)
        entry.inputLifecycleId = this.recentInputLifecycleForFailure(entry.acceptedAt);
      if (!this.failureSuppressedByLifecycle(entry.inputLifecycleId)) entry.notify?.();
    }
    this.purgeInputLifecycles();
  }
  /** The pairing registry is bounded; an evicted state is dispatched rather than silently lost. */
  private rememberFailure(entry: FailureArrival) {
    this.failureArrivals.push(entry);
    while (this.failureArrivals.length > MAX_FAILURE_PAIRS) {
      const expired = this.failureArrivals.shift();
      if (expired?.timer) clearTimeout(expired.timer);
      if (!this.failureSuppressedByLifecycle(expired?.inputLifecycleId)) expired?.notify?.();
    }
    this.purgeInputLifecycles();
  }

  private dispatchAttention(attention: PresenceStateV2, attentionKind: "error" | "success", severity: "error" | "success", title: string, body: string, origin: "local" | "external", immediateExternal = false) {
    const externalTransition = origin === "external" && this.externalAttention.accept(attention.source, attention.generation, attentionKind);
    if (origin === "external") {
      if (externalTransition) {
        // Deferred startup candidates are already bounded and ordered. Preserve
        // that order while retaining normal semantic dedupe, policy, and rate fences.
        if (immediateExternal) this.notify(severity, `external:${++this.externalNotificationSequence}:${severity}`, title, body, "external");
        else this.queueExternalAttention(severity, title, body);
      }
      return;
    }
    if (severity === "error") this.discardExternalProgress();
    this.notify(severity, `${attention.source}:${attention.generation}:${attention.sequence}:${this.turn}:${attention.attention?.reason}`, title, body, "local");
  }

  /** A terminal-only failure cannot be derived by unmodified Herdr from the V2 token map. */
  private notifyTerminalFailure(key: string, origin: "local" | "external"): boolean {
    return this.notify("error", key, "Pi needs attention", "A Pi task needs attention", origin);
  }

  private scheduleTerminalClear() {
    if (this.terminalClearTimer || this.terminalRecords.length === 0) return;
    const epoch = this.epoch;
    const timer = setTimeout(() => {
      if (this.terminalClearTimer !== timer) return;
      this.terminalClearTimer = undefined;
      if (this.epoch !== epoch) return;
      this.terminalRecords = [];
      this.terminalTombstones.clear();
      this.terminalOverflow = 0;
      this.renderMetadata();
    }, this.config.finalClearMs);
    timer.unref?.();
    this.terminalClearTimer = timer;
  }

  /** Event-bus bursts get one static alert; error replaces pending progress without delaying the first timer. */
  private queueExternalAttention(severity: "error" | "success" | "info", title: string, body: string) {
    const pending = this.externalPending;
    if (pending) {
      const priority = { info: 0, success: 1, error: 2 };
      if (priority[severity] > priority[pending.severity]) { pending.severity = severity; pending.title = title; pending.body = body; }
      return;
    }
    const next = { severity, title, body, timer: undefined as unknown as ReturnType<typeof setTimeout> };
    next.timer = setTimeout(() => {
      if (this.externalPending !== next) return;
      this.externalPending = null;
      this.notify(next.severity, `external:${++this.externalNotificationSequence}:${next.severity}`, next.title, next.body, "external");
    }, EXTERNAL_NOTIFICATION_COALESCE_MS);
    next.timer.unref?.();
    this.externalPending = next;
  }

  private discardExternalProgress() { const pending = this.externalPending; if (!pending || pending.severity === "error") return; clearTimeout(pending.timer); this.externalPending = null; }
  private clearExternalAttention() { if (this.externalPending) clearTimeout(this.externalPending.timer); this.externalPending = null; this.externalAttention.clear(); }
  /**
   * Dispatch one static, attribution-free toast only after synchronous queue
   * admission. Known queue/closed/serialization rejection must not consume a
   * dedupe or rate slot; delivery after dispatch remains intentionally unknown.
   */
  private notify(severity: NotificationSeverity, key: string, title: string, body: string, origin: "local" | "external"): boolean {
    if (!this.canOutput() || !shouldNotify(this.config.notificationPolicy, this.config.notifications, severity, origin)) return false;
    if (!this.notifications.canAccept(key)) { this.notifications.accept(key); return false; }
    const rateKind = this.notificationCooldownKind(severity, key);
    if (!this.notificationRate.canAccept(rateKind)) return false;
    const admitted = this.client?.notify(title, body, severity === "error" || severity === "attention", key) === true;
    if (!admitted) return false;
    // These operations follow the transport's synchronous admission callback
    // without an await, so preflight and commit cannot be interleaved in JS.
    this.notifications.accept(key);
    return this.notificationRate.commit(rateKind);
  }

  private notificationCooldownKind(severity: NotificationSeverity, key: string): NotificationCooldownKind {
    return severity === "error" ? "error" : key.startsWith("input:") ? "input" : key.startsWith("blocked:") ? "blocked" : "other";
  }

  private startLongRunningTimer() {
    this.clearLongRunningTimer();
    const epoch = this.epoch;
    const turn = this.turn;
    this.longRunningTimer = setTimeout(() => {
      this.longRunningTimer = undefined;
      if (this.epoch === epoch && this.active && this.turn === turn) this.notify("long-running", `long-running:${turn}`, "Pi is still working", "A Pi task is taking longer than expected", "local");
    }, this.config.longRunningMs);
    this.longRunningTimer.unref?.();
  }

  private clearLongRunningTimer() { if (this.longRunningTimer) clearTimeout(this.longRunningTimer); this.longRunningTimer = undefined; }

  /** Activate only unowned candidates. A successful takeover replays a newly ordinaled snapshot. */
  private activateLocalCandidates() {
    if (!this.rootSession || !this.consumerActive || !this.consumer) return;
    const emit = (name: string, payload: unknown) => { try { this.pi.events.emit(name, payload); } catch {} };
    if (!this.localPi) this.localPi = createPresenceProducer({ source: "pi", emit }) ?? null;
    if (!this.localTodo) this.localTodo = createPresenceProducer({ source: "todo", emit }) ?? null;
    const piActivated = !this.localPiActive && this.localPi?.activate() === true;
    const todoActivated = !this.localTodoActive && this.localTodo?.activate() === true;
    if (piActivated) this.localPiActive = true;
    if (todoActivated) this.localTodoActive = true;
    const reset = this.rotationPending;
    if (piActivated && this.lastPiState) this.replayLocalState("pi", reset);
    if (todoActivated && this.lastTodoState) this.replayLocalState("todo", reset);
    if (reset && (piActivated || todoActivated)) this.rotationPending = false;
  }

  private replayLocalState(source: LocalSource, reset: boolean) {
    const previous = source === "pi" ? this.lastPiState : this.lastTodoState;
    if (!previous) return;
    const ordinal = reset ? this.consumeLocalOrdinal() : this.nextLocalOrdinal();
    if (!ordinal || !(source === "pi" ? this.localPiActive : this.localTodoActive)) return;
    const { generation: _generation, sequence: _sequence, ...fields } = previous;
    const snapshot = { ...fields, generation: ordinal.generation, sequence: ordinal.sequence } as PresenceStateInputV2;
    if (source === "pi") this.publishPi(snapshot.state, ordinal);
    else this.publishTodo(snapshot);
  }

  private updateContextUsage() { try { this.usage.setContext(this.context?.getContextUsage?.()); } catch {} }
  private clearTerminalClearTimer() { if (this.terminalClearTimer) clearTimeout(this.terminalClearTimer); this.terminalClearTimer = undefined; }
  private clearFailureArrivals() {
    for (const entry of this.failureArrivals) if (entry.timer) clearTimeout(entry.timer);
    this.failureArrivals.length = 0;
  }

  private teardownLocal() {
    // Fallback for failed activation and every asynchronous teardown path.
    this.releaseCompanionBlocked();
    this.clearTerminalClearTimer();
    this.workspaceLease.stop();
    this.workspaceLease.update(null);
    this.clearPendingNotifications();
    this.initialProjectionInFlight = false;
    this.initialProjectionDirty = false;
    this.activationReplay = false;
    this.clearLongRunningTimer();
    this.clearExternalAttention();
    // The ordinary ordinal reservation leaves withdrawal room at the maximum generation.
    this.withdrawAndDeactivateLocalSources();
    this.localPi = null;
    this.localTodo = null;
    this.lastPiState = null;
    this.lastTodoState = null;
    this.rotationPending = false;
    this.consumer?.deactivate();
    this.consumer = null;
    this.consumerReady = null;
    this.consumerActive = false;
    this.outputReady = false;
    this.states.clear();
    this.terminalRecords = [];
    this.terminalTombstones.clear();
    this.terminalOverflow = 0;
    this.sessionId = null;
    this.sessionRef = null;
    this.context = null;
    this.sessionManager = null;
    this.ingressEpoch = null;
    this.ownerEpoch = 0;
    this.active = false;
    this.rootSession = false;
    this.nativePromptEpoch = null;
    this.resetInputNotificationState();
    this.clearInputLifecycles();
    this.notifications.clear();
    this.notificationRate.clear();
    this.inputNotificationTransitions = 0;
    this.clearFailureArrivals();
  }

  private async teardown(deadlineAt?: number) {
    // Detach the remote handle before local cleanup. An unowned activation
    // failure calls teardownLocal directly and therefore never reaches socket output.
    const client = this.client;
    const authorityGeneration = this.authorityGeneration;
    this.client = null;
    this.authorityGeneration = null;
    const mode = this.mode;
    this.mode = "disabled";
    this.teardownLocal();
    if (!client) return;
    const teardownClient = async () => {
      if (deadlineAt === undefined) { await client.teardown(this.config.timeoutMs).catch(() => {}); return; }
      // The fallback retains test-double compatibility; real clients always receive
      // the original absolute deadline rather than a refreshed stage timeout.
      const absolute = (client as PresenceClient & { teardownUntil?: (deadline: number) => Promise<void> }).teardownUntil;
      if (absolute) await absolute.call(client, deadlineAt).catch(() => {});
      else await client.teardown(this.remaining(deadlineAt)).catch(() => {});
    };
    if (mode === "companion") {
      await teardownClient();
      return;
    }
    if (authorityGeneration !== null && processCoordinator.isAuthority(authorityGeneration)) {
      await teardownClient();
      processCoordinator.releaseAuthority(authorityGeneration);
    } else await client.close(0).catch(() => {});
  }
}
