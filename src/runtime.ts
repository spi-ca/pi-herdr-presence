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
type FailureArrival = { source: string; generation: number; kind: "state" | "terminal"; expiresAt: number; timer?: ReturnType<typeof setTimeout>; notify?: () => void };
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
type PendingLifecycle = { epoch: number; id: string; manager: SessionManagerProvider; context: ContextUsageProvider; edges: PendingLifecycleEdge[]; overflow: boolean };
type PendingNotificationCandidate =
  | { kind: "state"; event: PresenceStateV2; inputPresent: boolean; suppressed: boolean; acceptedAt: number }
  | { kind: "terminal"; event: PresenceTerminalV2; acceptedAt: number }
  | { kind: "withdraw"; inputPresent: boolean; suppressed: boolean; acceptedAt: number };

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
  private inputLifecycleActive = false;
  private inputNotificationPending = false;
  private inputNotificationAttempted = false;
  /** Coalesce only simultaneous input lifecycles; distinct terminal edges stay live. */
  private inputNotificationTransitions = 0;
  private turn = 0;
  private toolFailed = false;
  private terminal: Terminal = "success";
  private usage = new UsageTracker();
  /** Fixed TTL for the current bounded terminal batch; bursts never extend it. */
  private terminalClearTimer: ReturnType<typeof setTimeout> | undefined;
  private longRunningTimer: ReturnType<typeof setTimeout> | undefined;
  private externalAttention = new ExternalAttentionTransitions();
  private notifications = new NotificationDeduper();
  private notificationRate = new NotificationRateLimiter();
  private readonly failureArrivals: FailureArrival[] = [];
  private externalPending: { severity: "error" | "success" | "info"; title: string; body: string; timer: ReturnType<typeof setTimeout> } | null = null;
  private externalNotificationSequence = 0;

  constructor(private pi: ExtensionAPI, private config: PresenceConfig) {}

  async startSession(context: unknown, event?: unknown) {
    const epoch = ++this.epoch;
    // A session boundary permits a distinct Todo implementation in the new root.
    this.todo.reset();
    this.clearPendingNotifications();
    this.notificationAcceptanceTime = 0;
    // A replacement must not leave the previous consumer able to accept same-tick ingress.
    this.ingressEpoch = null;
    const current = session(context);
    this.pendingLifecycle = (context as { mode?: unknown })?.mode === "tui" && current
      ? { epoch, id: current.id, manager: current.manager, context: context as ContextUsageProvider, edges: [], overflow: false }
      : null;
    return this.queueStartup(() => this.beginSession(context, event, epoch, current));
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

  private async beginSession(context: unknown, event: unknown, epoch: number, current: RuntimeSession | null) {
    await this.teardown();
    if (epoch !== this.epoch) return;
    if ((context as { mode?: unknown })?.mode !== "tui") { this.abandonStartup(epoch); return; }
    const identity = readHerdrIdentity();
    // Use the session_start snapshot, not a potentially mutated manager read
    // after asynchronous authority probing.
    if (!identity || !current) { this.abandonStartup(epoch); return; }
    let mode: PresenceMode = "disabled";
    try { mode = resolvePresenceMode(this.config, await officialHookStatus()); } catch {}
    if (epoch !== this.epoch) return;
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
    this.inputNotificationPending = false;
    this.inputNotificationAttempted = false;
    this.inputNotificationTransitions = 0;
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
    // Claim only after this lane has retired this runtime's prior authority and
    // activation succeeded. A later stale teardown sees a different generation
    // and closes locally without sending pane cleanup for this new owner.
    if (mode === "standalone") this.authorityGeneration = processCoordinator.claimAuthority();
    this.client = client;
    try {
      // Standalone clears current/legacy ownership before restoring authority;
      // companion clears only its separately-owned token projection.
      await client.prepareSessionAuthority();
      if (epoch !== this.epoch || this.client !== client || !this.consumerActive) return;
      if (mode === "standalone") await client.reportSession(current.ref, typeof (event as { reason?: unknown })?.reason === "string" ? (event as { reason: string }).reason : undefined);
    } catch {
      // Lifecycle output is observer-only; buffered retained state still gets
      // one quiet render after bounded cleanup and session attempts settle.
    }
    if (epoch !== this.epoch || this.client !== client || !this.consumerActive) return;

    // Retained replay only reconstructs state. Keep public output closed while
    // the internal startup path awaits report + metadata, so live ingress cannot
    // race a stale initial projection into the socket queue.
    this.initialProjectionInFlight = true;
    let stabilized = false;
    for (let pass = 0; pass < MAX_STARTUP_PROJECTION_PASSES; pass += 1) {
      // Clear immediately before every await: ingress during that pass requires
      // another complete snapshot, while the public output gate remains closed.
      this.initialProjectionDirty = false;
      await this.renderCurrent(true);
      if (epoch !== this.epoch || this.client !== client || !this.consumerActive) return;
      if (!this.initialProjectionDirty) { stabilized = true; break; }
    }
    if (!stabilized) {
      // Do not publish a projection known to have been superseded. Fence ingress
      // synchronously, then retire this runtime's client and consumer ownership.
      this.ingressEpoch = null;
      this.outputReady = false;
      this.discardPendingLifecycle(epoch);
      await this.teardown();
      return;
    }
    // No await may separate the clean-pass check from this release.
    this.outputReady = true;
    this.initialProjectionInFlight = false;
    // Retained terminals get their normal bounded metadata lifetime, but never a toast.
    this.scheduleTerminalClear();
    // Consumer activation may synchronously replay retained V2 state. It is
    // projected above, but never promoted into a visible notification. Live
    // edges accepted only after activate() returned drain once, in arrival order.
    this.drainPendingNotifications();
    this.activateLocalCandidates();
    this.updateContextUsage();
    const pending = this.pendingLifecycle?.epoch === epoch && this.pendingLifecycle.id === current.id && this.pendingLifecycle.manager === current.manager ? this.pendingLifecycle : null;
    this.discardPendingLifecycle(epoch);
    if (pending) {
      this.replayPendingLifecycle(pending);
      if (!pending.overflow && pending.edges.some(edge => edge.kind === "agent_start")) return;
    }
    let reloadActive = false;
    try { reloadActive = (context as { isIdle?: () => boolean }).isIdle?.() === false; } catch {}
    if (reloadActive) {
      this.active = true;
      this.turn += 1;
      this.startLongRunningTimer();
      this.publish("running");
    } else this.publish("idle");
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
      const inputPresent = [...this.states.values()].some(isInteractionWaiting);
      const suppressed = [...this.states.values()].some(candidate => candidate.state === "error" || candidate.attention?.reason === "failure");
      // Retained activation replay is state reconstruction, never an alert.
      if (!this.outputReady || deferLiveNotification) {
        if (deferLiveNotification) this.appendPendingNotification({ kind: "state", event, inputPresent, suppressed, acceptedAt: this.nextNotificationAcceptanceTime() });
        return;
      }
      this.render(event);
      this.syncInputNotification(isLiveInputRequest(event));
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
    const inputPresent = [...this.states.values()].some(isInteractionWaiting);
    const suppressed = [...this.states.values()].some(candidate => candidate.state === "error" || candidate.attention?.reason === "failure");
    if (!this.outputReady || deferLiveNotification) {
      if (deferLiveNotification) this.appendPendingNotification({ kind: "withdraw", inputPresent, suppressed, acceptedAt: this.nextNotificationAcceptanceTime() });
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
    // only the original acceptance times, then dispatch every unpaired failure
    // directly in accepted order instead of starting fresh drain-time timers.
    const paired = new Set<PendingNotificationCandidate>();
    for (const state of pending) {
      if (state.kind !== "state" || state.event.attention?.reason !== "failure" || paired.has(state)) continue;
      const terminal = pending.find(candidate => candidate.kind === "terminal"
        && !paired.has(candidate)
        && candidate.event.outcome === "failed"
        && candidate.event.source === state.event.source
        && candidate.event.generation === state.event.generation
        && Math.abs(candidate.acceptedAt - state.acceptedAt) <= FAILURE_PAIR_WINDOW_MS);
      if (terminal) { paired.add(state); paired.add(terminal); }
    }
    for (const candidate of pending) {
      if (!this.canOutput()) return;
      if (candidate.kind === "terminal") this.dispatchTerminal(candidate.event, false);
      else if (candidate.kind === "state") {
        if (!paired.has(candidate)) this.dispatchStateAttention(candidate.event, false, true);
        this.syncInputNotification(isLiveInputRequest(candidate.event), candidate.inputPresent, candidate.suppressed);
      } else this.syncInputNotification(false, candidate.inputPresent, candidate.suppressed);
    }
  }

  private nextNotificationAcceptanceTime(): number {
    // Wall-clock time can be frozen or adjusted while startup is blocked. The
    // process monotonic clock preserves the actual producer acceptance window.
    const now = Number(process.hrtime.bigint() / 1_000_000n);
    this.notificationAcceptanceTime = Math.min(MAX_INTEGER, Math.max(this.notificationAcceptanceTime, now));
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
        this.publishPi(this.terminal, this.terminal === "error" ? "failure" : undefined, stateOrdinal);
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
    // An unfenced shutdown could tear down a replacement session. Unlike
    // ordinary callbacks, /fork may mutate the legitimate owner's ID before
    // Pi emits shutdown, so this fence intentionally checks manager + epoch.
    if (!this.shutdownSessionFence(context) && !this.pendingShutdownFence(context)) return;
    ++this.epoch;
    this.ingressEpoch = null;
    this.outputReady = false;
    this.pendingLifecycle = null;
    this.clearPendingNotifications();
    this.clearExternalAttention();
    this.clearFailureArrivals();
    // Reserve this teardown synchronously. A cache-busted replacement can queue
    // startup immediately afterwards, but cannot acquire authority before this
    // client's bounded remote cleanup has completed.
    return processCoordinator.enqueueAuthority(() => this.transition(() => this.teardown()));
  }

  private publish(state: PresenceStateInputV2["state"], reason?: "failure") {
    if (!this.rootSession) return;
    const ordinal = this.nextLocalOrdinal();
    if (ordinal) this.publishPi(state, reason, ordinal);
  }

  private publishPi(state: PresenceStateInputV2["state"], reason: "failure" | undefined, ordinal: { generation: number; sequence: number }) {
    const snapshot: PresenceStateInputV2 = { version: 2, generation: ordinal.generation, sequence: ordinal.sequence, source: "pi", state, ...(reason ? { attention: { reason, occurrence: "new" as const } } : {}) };
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

  /** One live input lifecycle yields at most one alert; retained replay only restores pane state. */
  private syncInputNotification(liveInput = false, inputPresent = [...this.states.values()].some(isInteractionWaiting), suppressed = [...this.states.values()].some(event => event.state === "error" || event.attention?.reason === "failure")) {
    if (!inputPresent) { this.inputLifecycleActive = false; this.inputNotificationPending = false; this.inputNotificationAttempted = false; return; }
    if (!this.inputLifecycleActive) this.inputLifecycleActive = true;
    if (this.inputNotificationAttempted) return;
    if (liveInput) this.inputNotificationPending = true;
    if (!this.inputNotificationPending || !this.outputReady || suppressed) return;
    this.inputNotificationTransitions = Math.min(MAX_NOTIFICATION_TRANSITIONS, this.inputNotificationTransitions + 1);
    this.discardExternalProgress();
    this.inputNotificationAttempted = this.notify("attention", `input:${this.turn}:${this.inputNotificationTransitions}`, "Pi needs your input", "Pi needs your input", "local");
    if (this.inputNotificationAttempted) this.inputNotificationPending = false;
  }

  /** The startup projection is awaited so agent, metadata, then notifications stay ordered. */
  private async renderCurrent(startup = false) {
    const ref = this.sessionRef;
    const client = this.client;
    const internalStartupOutput = startup && this.initialProjectionInFlight && this.isIngressOpen() && this.rootSession && this.consumerActive;
    if ((!this.canOutput() && !internalStartupOutput) || !ref || !client) return;
    const events = [...this.states.values()];
    const state = compositeState(events, this.active);
    const terminals = this.currentTerminalBatch();
    if (this.mode === "standalone") await client.report(state, ref, safeMessage(state, this.config.maxLabelChars, events, this.active));
    await client.metadata(presentation(), metadata(events, terminals, this.usage.snapshot(), this.active, state, this.latestTerminalOutcome()));
  }

  private render(attention?: PresenceStateV2) {
    const ref = this.sessionRef;
    const client = this.client;
    if (!this.canOutput() || !ref || !client) return;
    const events = [...this.states.values()];
    const state = compositeState(events, this.active);
    if (this.mode === "standalone") void client.report(state, ref, safeMessage(state, this.config.maxLabelChars, events, this.active));
    this.renderMetadata(events, client, state);

    this.dispatchStateAttention(attention);
  }

  /** Metadata-only refreshes must not repeat an unchanged pane agent report. */
  private renderMetadata(events = [...this.states.values()], client = this.client, state = compositeState(events, this.active)) {
    if (!this.canOutput() || !client) return;
    void client.metadata(presentation(), metadata(events, this.currentTerminalBatch(), this.usage.snapshot(), this.active, state, this.latestTerminalOutcome()));
  }

  /** Applies one already-accepted live state edge without re-rendering startup state. */
  private dispatchStateAttention(attention?: PresenceStateV2, deferFailure = true, immediateExternal = false) {
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
        this.queueStateFailure(attention.source, attention.generation, () =>
          this.dispatchAttention(attention, attentionKind, severity, text.title, text.body, origin),
        );
        return;
      }
      // A startup edge already waited for its pairing decision. Do not give an
      // unpaired external failure a second coalescing timer that can reorder it.
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
    if (emitMetadata && this.rootSession && this.consumerActive && this.outputReady && client) {
      void client.metadata(presentation(), metadata(events, this.currentTerminalBatch(), this.usage.snapshot(), this.active, compositeState(events, this.active), this.latestTerminalOutcome()));
    }
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
  private queueStateFailure(source: string, generation: number, notify: () => void) {
    this.purgeFailureArrivals();
    const terminalIndex = this.failureArrivals.findIndex(entry => entry.source === source && entry.generation === generation && entry.kind === "terminal");
    if (terminalIndex >= 0) { this.removeFailureArrival(this.failureArrivals[terminalIndex]!); return; }
    const entry: FailureArrival = { source, generation, kind: "state", expiresAt: Date.now() + FAILURE_PAIR_WINDOW_MS, notify };
    entry.timer = setTimeout(() => this.expireFailureArrival(entry), FAILURE_PAIR_WINDOW_MS);
    entry.timer.unref?.();
    this.rememberFailure(entry);
  }

  /** A terminal never loses its own alert; it only cancels one paired state alert. */
  private suppressPairedStateFailure(source: string, generation: number) {
    this.purgeFailureArrivals();
    const stateIndex = this.failureArrivals.findIndex(entry => entry.source === source && entry.generation === generation && entry.kind === "state");
    if (stateIndex >= 0) { this.removeFailureArrival(this.failureArrivals[stateIndex]!); return; }
    const entry: FailureArrival = { source, generation, kind: "terminal", expiresAt: Date.now() + FAILURE_PAIR_WINDOW_MS };
    entry.timer = setTimeout(() => this.expireFailureArrival(entry), FAILURE_PAIR_WINDOW_MS);
    entry.timer.unref?.();
    this.rememberFailure(entry);
  }

  private expireFailureArrival(entry: FailureArrival) {
    if (!this.removeFailureArrival(entry)) return;
    entry.notify?.();
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
    for (const entry of [...this.failureArrivals]) if (entry.expiresAt <= now && this.removeFailureArrival(entry)) entry.notify?.();
  }
  /** The pairing registry is bounded; an evicted state is dispatched rather than silently lost. */
  private rememberFailure(entry: FailureArrival) {
    this.failureArrivals.push(entry);
    while (this.failureArrivals.length > MAX_FAILURE_PAIRS) {
      const expired = this.failureArrivals.shift();
      if (expired?.timer) clearTimeout(expired.timer);
      expired?.notify?.();
    }
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
  /** Dispatches one static, attribution-free toast after policy, TTL/LRU, and rate fences. */
  private notify(severity: NotificationSeverity, key: string, title: string, body: string, origin: "local" | "external"): boolean {
    if (!this.canOutput() || !shouldNotify(this.config.notificationPolicy, this.config.notifications, severity, origin)) return false;
    if (!this.notifications.canAccept(key)) { this.notifications.accept(key); return false; }
    if (!this.notificationRate.accept(this.notificationCooldownKind(severity, key))) return false;
    this.notifications.accept(key);
    void this.client?.notify(title, body, severity === "error" || severity === "attention", key);
    return true;
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
    if (source === "pi") this.publishPi(snapshot.state, snapshot.attention?.reason === "failure" ? "failure" : undefined, ordinal);
    else this.publishTodo(snapshot);
  }

  private updateContextUsage() { try { this.usage.setContext(this.context?.getContextUsage?.()); } catch {} }
  private clearTerminalClearTimer() { if (this.terminalClearTimer) clearTimeout(this.terminalClearTimer); this.terminalClearTimer = undefined; }
  private clearFailureArrivals() {
    for (const entry of this.failureArrivals) if (entry.timer) clearTimeout(entry.timer);
    this.failureArrivals.length = 0;
  }

  private teardownLocal() {
    this.clearTerminalClearTimer();
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
    this.inputLifecycleActive = false;
    this.notifications.clear();
    this.notificationRate.clear();
    this.inputNotificationPending = false;
    this.inputNotificationAttempted = false;
    this.inputNotificationTransitions = 0;
    this.clearFailureArrivals();
  }

  private async teardown() {
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
    if (mode === "companion") { await client.teardown(this.config.timeoutMs).catch(() => {}); return; }
    if (authorityGeneration !== null && processCoordinator.isAuthority(authorityGeneration)) {
      await client.teardown(this.config.timeoutMs).catch(() => {});
      processCoordinator.releaseAuthority(authorityGeneration);
    } else await client.close(0).catch(() => {});
  }
}
