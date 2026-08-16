import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PresenceClient } from "./client.js";
import type { PresenceConfig } from "./config.js";
import {
  PI_PRESENCE_READY_EVENT,
  PI_PRESENCE_UPDATE_EVENT,
  parsePresenceReady,
  parsePresenceRemove,
  parsePresenceSessionId,
  parsePresenceUpdate,
  PresenceEventRegistry,
  type PresenceUpdate,
} from "./events.js";
import { readCmuxIdentity, resolveCmuxSocketPath } from "./identity.js";
import { officialHookDetected } from "./official-hook.js";
import {
  PI_SUBAGENT_SOURCE_ID,
  fixedCoalescingDeadline,
  observeSubagentTerminal,
  remainingErrorDeadlineMs,
  shouldFlashAttention,
  shouldNotifyAttention,
  type AttentionKind,
  type SubagentTerminalBaseline,
} from "./notification-policy.js";
import {
  aggregateMetadata,
  attentionLevel,
  deriveTerminalState,
  formatAttentionTitle,
  formatAutoTitle,
  formatLocalTurnPresentation,
  formatSubagentAttention,
  formatProgressText,
  formatStateText,
  PRESENCE_STATE_STYLES,
  presenceStatusKey,
  selectProgress,
} from "./presentation.js";
import { TodoProgressAdapter } from "./todo.js";
import { UnixSocketTransport } from "./transport.js";
import { UsageTracker } from "./usage.js";

const LOCAL_SOURCE = { id: "pi", label: "Pi", kind: "agent" };
const TODO_SOURCE = "pi-todo";

type ContextProvider = { getContextUsage?: () => unknown };
type TerminalState = "success" | "error" | "cancelled";
type ToolFeedEvent = { toolCallId?: unknown; toolName?: unknown };
type OfficialHookDetector = () => Promise<boolean>;

type RuntimeClock = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

/** Production uses a monotonic clock; tests can inject a deterministic scheduler. */
const SYSTEM_RUNTIME_CLOCK: RuntimeClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

type DetachedSession = {
  client: PresenceClient | null;
  sessionId: string | null;
  officialHook: boolean;
  statusScope: string | undefined;
  retainedEvents: PresenceUpdate[];
};

type PendingSubagentAttention = {
  generation: number;
  completedDelta: number;
  failedDelta: number;
  terminal: AttentionKind;
  /** Parent run that can settle this burst; zero means independent. */
  parentRun: number;
  /** Fixed semantic burst deadline: first success + 450ms or first error + 100ms. */
  coalesceDeadline: number | null;
  /** First-error + 10s active-parent maximum wait deadline. */
  errorDeadline: number | null;
  /** Terminal outcome recorded when the parent settles during this burst. */
  parentSettled: TerminalState | null;
};

type SuppressedParentAttention = {
  readonly parentRun: number;
  readonly attention: "info" | AttentionKind;
  readonly completed: number;
  readonly failed: number;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sessionIdFromContext(context: unknown): string | null {
  try {
    if (typeof context !== "object" || context === null) return null;
    const sessionManager = (context as { sessionManager?: unknown }).sessionManager;
    if (typeof sessionManager !== "object" || sessionManager === null) return null;
    const getSessionId = (sessionManager as { getSessionId?: unknown }).getSessionId;
    if (typeof getSessionId !== "function") return null;
    return parsePresenceSessionId(getSessionId.call(sessionManager));
  } catch {
    return null;
  }
}

/** Owns presence session state and best-effort side effects; hook wiring lives in hooks.ts. */
export class PresenceRuntime {
  private readonly registry = new PresenceEventRegistry();
  private readonly todo = new TodoProgressAdapter();
  private client: PresenceClient | null = null;
  private clientCloseBarrier: Promise<void> = Promise.resolve();
  private contextProvider: ContextProvider | null = null;
  private sessionId: string | null = null;
  private sessionEpoch = 0;
  private generation = 0;
  private localSequence = 0;
  private active = false;
  private completed = 0;
  private failed = 0;
  private usage = new UsageTracker();
  private terminal: TerminalState = "success";
  private hadToolError = false;
  private shownProgress = false;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;
  private subagentBaseline: SubagentTerminalBaseline | null = null;
  private subagentPending: PendingSubagentAttention | null = null;
  private subagentTimer: ReturnType<typeof setTimeout> | undefined;
  private subagentTimerEpoch = 0;
  private parentRunRevision = 0;
  /** Suppresses a terminal after its child error already timed out at 10 seconds. */
  private fencedParentRun: number | null = null;
  private suppressParentAttentionOnce = false;
  /** A trusted local terminal held only while its child error burst is pending. */
  private suppressedParentAttention: SuppressedParentAttention | null = null;
  private officialHook = false;
  private statusScope: string | undefined;
  /** Exact synchronous identities prevent this consumer from handling its own ready output. */
  private ownReadyAdvertisement: object | null = null;
  private ownReadyRequest: object | null = null;
  /** A mutating event observer cannot recursively multiply one request response. */
  private readyResponseInFlight = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: PresenceConfig,
    private readonly clock: RuntimeClock = SYSTEM_RUNTIME_CLOCK,
    private readonly detectOfficialHook: OfficialHookDetector = officialHookDetected,
  ) {}

  handlePresenceUpdate(payload: unknown): void {
    try {
      const event = parsePresenceUpdate(payload);
      if (!event
        || event.source.id === LOCAL_SOURCE.id
        || event.source.id === TODO_SOURCE
        || !this.registry.acceptParsed(event)) {
        return;
      }
      this.apply(event);
    } catch {
      // Untrusted event-bus input is always best-effort.
    }
  }

  handlePresenceRemove(payload: unknown): void {
    try {
      const event = parsePresenceRemove(payload);
      if (!event || event.source.id === LOCAL_SOURCE.id || event.source.id === TODO_SOURCE) return;
      const result = this.registry.acceptParsedRemove(event);
      if (!result.accepted) return;

      // Removal has no producer-controlled presentation or attention. It only
      // withdraws the exact status the registry previously accepted.
      if (event.source.id === PI_SUBAGENT_SOURCE_ID) {
        this.invalidateSubagentNotifications();
      }
      if (result.removed) {
        void this.client?.clearStatus(this.statusKey(event.source.id));
      }
      this.renderProgress();
      if (!this.officialHook && this.config.metaBlock) {
        void this.client?.meta(this.metadata());
      }
    } catch {
      // Untrusted event-bus input is always best-effort.
    }
  }

  handleReady(payload: unknown): void {
    try {
      // Check identity before parsing: our frozen startup request and response
      // advertisement are synchronous bus output, never peer input.
      if (payload === this.ownReadyAdvertisement || payload === this.ownReadyRequest) return;
      const ready = parsePresenceReady(payload);
      if (!ready || ready.sessionId !== this.sessionId || ready.consumer) return;
      // A consumer-less ready is the only replay/discovery request. Keep the
      // guard through both output phases so reentrant observers cannot turn
      // one request into a nested replay fan-out.
      if (this.readyResponseInFlight) return;
      this.readyResponseInFlight = true;
      try {
        this.emitReadyAdvertisement(ready.sessionId);
        this.replayRetainedLocalEvents();
      } finally {
        this.readyResponseInFlight = false;
      }
    } catch {
      // Ready discovery and replay must never affect Pi work.
    }
  }

  async startSession(context: unknown): Promise<void> {
    const epoch = ++this.sessionEpoch;
    this.cancelFinalClear();

    const previousSession = this.detachCurrentSession();
    this.generation += 1;

    const nextSessionId = sessionIdFromContext(context);
    await this.cleanupDetachedSession(previousSession);
    if (epoch !== this.sessionEpoch || nextSessionId === null) return;

    this.beginSession(nextSessionId, context);
    const detectedOfficialHook = await this.detectOfficialHook();
    if (!this.isCurrent(epoch, nextSessionId)) return;
    this.officialHook = detectedOfficialHook;

    const identity = readCmuxIdentity();
    this.statusScope = identity?.surfaceId;
    const socketPath = identity ? await resolveCmuxSocketPath() : null;
    if (!this.isCurrent(epoch, nextSessionId)) return;

    if (identity && socketPath) {
      const created = new PresenceClient(
        identity,
        new UnixSocketTransport(socketPath, this.config.timeoutMs, this.config.maxQueue),
        this.config,
      );
      await created.initialize();
      if (!this.isCurrent(epoch, nextSessionId)) {
        await created.close();
        return;
      }
      await created.initializeOwnedProgress();
      if (!this.isCurrent(epoch, nextSessionId)) {
        await created.close();
        return;
      }
      this.client = created;
    }

    await this.initializeOptionalIntegrations(nextSessionId);
    if (!this.isCurrent(epoch, nextSessionId)) return;

    // The advertisement lets already-running producers discover this
    // consumer; the following consumer-less request makes them replay once.
    this.emitReadyAdvertisement(nextSessionId);
    this.emitReadyRequest(nextSessionId);
    this.publish("idle");
    if (!this.officialHook) {
      void this.client?.feed("SessionStart", nextSessionId);
      if (this.config.metaBlock) void this.client?.meta(this.metadata());
    }
  }

  handleAgentStart(): void {
    if (!this.sessionId) return;
    this.cancelFinalClear();
    if (!this.active) {
      // Clock time can move past a deadline before its queued callback runs.
      // Reconcile before this start can claim an inactive grace or reuse a run.
      this.reconcileElapsedSubagentAttention();
      const pending = this.subagentPending;
      if (pending && pending.parentSettled !== null) {
        // A settled parent's aggregate must not cross a run boundary, even if
        // its deadline elapsed before the timer callback reached the event loop.
        this.dispatchSubagentAttention(pending.generation, {
          parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
        });
      }
      this.active = true;
      this.parentRunRevision += 1;
      // A timeout fence belongs only to its original parent run.
      if (this.fencedParentRun !== this.parentRunRevision) this.fencedParentRun = null;
      this.usage = new UsageTracker();
      this.hadToolError = false;
    }
    this.terminal = "success";
    this.updateContextUsage();
    this.publish("running");
    if (!this.officialHook && this.config.nativeLifecycle) {
      void this.client?.lifecycle("running");
    }
  }

  handleTurnStart(): void {
    if (this.sessionId && this.active) this.updateContextUsage();
  }

  handleMessageEnd(event: unknown): void {
    if (!this.sessionId || typeof event !== "object" || event === null) return;
    const message = (event as { message?: unknown }).message;
    if (typeof message !== "object" || message === null) return;
    const assistant = message as { role?: unknown; usage?: unknown };
    if (assistant.role !== "assistant") return;
    this.usage.add(assistant.usage);
    this.updateContextUsage();
  }

  handleAgentEnd(event: unknown): void {
    if (!this.sessionId || typeof event !== "object" || event === null) return;
    const messages = (event as { messages?: unknown }).messages;
    this.terminal = deriveTerminalState(Array.isArray(messages) ? messages : [], this.hadToolError);
  }

  handleBeforeAgentStart(): void {
    if (!this.officialHook && this.sessionId) {
      void this.client?.feed("UserPromptSubmit", this.sessionId);
    }
  }

  handleToolExecutionStart(event: ToolFeedEvent): void {
    this.feedToolEvent("PreToolUse", event);
  }

  handleToolExecutionEnd(event: ToolFeedEvent): void {
    this.feedToolEvent("PostToolUse", event);
  }

  handleToolResult(event: unknown): void {
    if (!this.sessionId) return;
    if (typeof event === "object" && event !== null && (event as { isError?: unknown }).isError === true && this.active) {
      this.hadToolError = true;
    }

    let todoEvent: PresenceUpdate | null = null;
    try {
      todoEvent = this.todo.accept(
        event,
        this.pi.getAllTools(),
        this.sessionId,
        this.generation,
        ++this.localSequence,
      );
    } catch {
      // Tool provenance and result parsing are best-effort.
    }
    if (!todoEvent || !this.registry.acceptParsed(todoEvent)) return;

    this.apply(todoEvent);
    this.emitUpdate(todoEvent);
  }

  handleAgentSettled(context: unknown): void {
    try {
      if (typeof context === "object" && context !== null) {
        const isIdle = (context as { isIdle?: unknown }).isIdle;
        if (typeof isIdle === "function" && !isIdle.call(context)) return;
      }
    } catch {
      return;
    }
    this.finalizeAgent();
  }

  /** Used only when a host rejects agent_settled registration. */
  handleAgentEndFallback(): void {
    this.finalizeAgent();
  }

  handleSessionInfoChanged(event: unknown): void {
    if (!this.sessionId || this.officialHook || !this.config.autoTitle) return;
    if (typeof event !== "object" || event === null) return;
    const name = (event as { name?: unknown }).name;
    if (typeof name !== "string" || !name.trim()) return;
    void this.client?.autoTitle(formatAutoTitle(name, Math.min(80, this.config.maxLabelChars)));
  }

  async shutdownSession(): Promise<void> {
    ++this.sessionEpoch;
    this.cancelFinalClear();

    const closingSession = this.detachCurrentSession();
    await this.cleanupDetachedSession(closingSession);
  }

  private finalizeAgent(): void {
    if (!this.sessionId || !this.active) return;
    this.active = false;
    this.updateContextUsage();
    if (this.terminal === "error") this.failed += 1;
    else if (this.terminal === "success") this.completed += 1;

    const attention = this.terminal === "error"
      ? "error"
      : this.terminal === "success"
        ? "success"
        : "none";
    // A cancelled local run is status-only: it must not publish an attention
    // event even under permissive notification or flash policies.
    this.suppressParentAttentionOnce = this.flushSubagentForParentSettlement(attention);
    this.publish(this.terminal, attention);
    this.scheduleFinalClear(this.sessionEpoch);

    if (!this.officialHook) {
      if (this.config.nativeLifecycle) void this.client?.lifecycle("idle");
      void this.client?.feed("Stop", this.sessionId);
      if (this.config.metaBlock) void this.client?.meta(this.metadata());
    }
  }

  private beginSession(sessionId: string, context: unknown): void {
    this.sessionId = sessionId;
    this.registry.start(sessionId);
    this.contextProvider = typeof context === "object" && context !== null
      ? context as ContextProvider
      : null;
    this.localSequence = 0;
    this.active = false;
    this.completed = 0;
    this.failed = 0;
    this.usage = new UsageTracker();
    this.terminal = "success";
    this.hadToolError = false;
    this.shownProgress = false;
    this.resetSubagentNotifications();
    this.parentRunRevision = 0;
    this.fencedParentRun = null;
    this.officialHook = false;
    this.statusScope = undefined;
  }

  private detachCurrentSession(): DetachedSession {
    const detached = {
      client: this.client,
      sessionId: this.sessionId,
      officialHook: this.officialHook,
      statusScope: this.statusScope,
      retainedEvents: this.registry.snapshot(),
    };
    this.client = null;
    this.disableCurrentSession();
    return detached;
  }

  private disableCurrentSession(): void {
    this.registry.stop();
    this.contextProvider = null;
    this.sessionId = null;
    this.localSequence = 0;
    this.active = false;
    this.completed = 0;
    this.failed = 0;
    this.usage = new UsageTracker();
    this.terminal = "success";
    this.hadToolError = false;
    this.shownProgress = false;
    this.resetSubagentNotifications();
    this.parentRunRevision = 0;
    this.fencedParentRun = null;
    this.suppressParentAttentionOnce = false;
    this.officialHook = false;
    this.statusScope = undefined;
    this.ownReadyAdvertisement = null;
    this.ownReadyRequest = null;
    this.readyResponseInFlight = false;
  }

  private isCurrent(epoch: number, sessionId: string): boolean {
    return epoch === this.sessionEpoch && sessionId === this.sessionId;
  }

  private async initializeOptionalIntegrations(sessionId: string): Promise<void> {
    if (!this.officialHook && this.config.nativeLifecycle) {
      void this.client?.setPiPid();
      void this.client?.lifecycle("idle");
    }

    if (!this.officialHook && this.config.autoTitle) {
      let currentName: unknown;
      try {
        currentName = typeof this.pi.getSessionName === "function"
          ? this.pi.getSessionName()
          : undefined;
      } catch {
        currentName = undefined;
      }
      if (typeof currentName === "string" && currentName.trim()) {
        void this.client?.autoTitle(
          formatAutoTitle(currentName, Math.min(80, this.config.maxLabelChars)),
        );
      }
    }

    if (!this.officialHook && this.config.resumeFallback) {
      await this.client?.installResumeFallback(
        sessionId,
        `pi --session ${shellQuote(sessionId)}`,
      );
    }
  }

  private apply(event: PresenceUpdate): void {
    const localPresentation = event.source.id === LOCAL_SOURCE.id
      ? formatLocalTurnPresentation(event.state, this.config.maxLabelChars)
      : null;
    const label = localPresentation?.sidebar ?? formatStateText(event, this.config.maxLabelChars);
    void this.client?.status(
      this.statusKey(event.source.id),
      label,
      PRESENCE_STATE_STYLES[event.state],
    );
    this.renderProgress();

    if (event.source.id === PI_SUBAGENT_SOURCE_ID) {
      this.observeSubagentAttention(event);
    } else {
      const level = attentionLevel(event.attention);
      const suppressParentAttention = event.source.id === LOCAL_SOURCE.id && this.suppressParentAttentionOnce;
      if (suppressParentAttention) this.suppressParentAttentionOnce = false;
      // Official hooks already own local completion attention. Generic producers
      // remain immediate, but both native effects obey the global policies.
      if (level && !suppressParentAttention && !(this.officialHook && event.source.id === LOCAL_SOURCE.id)) {
        void this.client?.log(level, label);
        if (!this.config.suppressNativeNotifications && shouldNotifyAttention(
          this.config.notificationPolicy,
          this.config.notifications,
          event.attention,
          event.source.id === LOCAL_SOURCE.id ? "local" : "external",
        )) {
          void this.client?.notify(
            localPresentation?.title ?? formatAttentionTitle(event, this.config.maxLabelChars),
            localPresentation?.body ?? label,
          );
        }
        if (!this.config.suppressNativeFlash && shouldFlashAttention(
          this.config.flashPolicy,
          this.config.flash,
          this.config.notificationPolicy,
          event.attention,
          event.source.id === LOCAL_SOURCE.id ? "local" : "external",
        )) {
          void this.client?.flash();
        }
      }
    }
    if (!this.officialHook && this.config.metaBlock) {
      void this.client?.meta(this.metadata());
    }
  }

  /** The pi-subagent producer is cumulative and gets the only aggregate path. */
  private observeSubagentAttention(event: PresenceUpdate): void {
    const observation = observeSubagentTerminal(this.subagentBaseline, event);
    this.subagentBaseline = observation.baseline;
    if (observation.reset || observation.generationChanged) {
      const invalidated = this.subagentPending;
      this.clearSubagentTimer();
      this.subagentPending = null;
      // A deferred aggregate owns the local terminal only while that exact
      // cumulative producer generation remains valid.
      if (invalidated && invalidated.parentSettled !== null) {
        this.dispatchSuppressedParentAttention(invalidated.parentRun);
      }
    }
    if (!observation.terminal) return;

    // A terminal arriving after an elapsed deadline starts a fresh aggregate;
    // it must not merge into the aggregate that deadline already closed.
    this.reconcileElapsedSubagentAttention();
    const existing = this.subagentPending;
    const sameAggregate = existing?.generation === event.generation;
    const priorTerminal = sameAggregate ? existing.terminal : null;
    const pending: PendingSubagentAttention = sameAggregate
      ? {
        ...existing,
        completedDelta: existing.completedDelta + observation.completedDelta,
        failedDelta: existing.failedDelta + observation.failedDelta,
        terminal: observation.terminal === "error" ? "error" : existing.terminal,
      }
      : {
        generation: event.generation,
        completedDelta: observation.completedDelta,
        failedDelta: observation.failedDelta,
        terminal: observation.terminal,
        // Success gets a short next-parent grace; an independent error never
        // becomes owned merely because a parent starts during its 100ms window.
        parentRun: this.active ? this.parentRunRevision : observation.terminal === "success" ? this.parentRunRevision + 1 : 0,
        coalesceDeadline: null,
        errorDeadline: null,
        parentSettled: null,
      };
    this.subagentPending = pending;

    const now = this.clock.now();
    // Closed windows are deliberately not extended. The next terminal starts
    // its own fixed semantic window while its counts remain in this parent
    // aggregate for a single eventual settlement notification.
    const errorSupersedesSuccess = observation.terminal === "error" && priorTerminal === "success";
    // An inactive success temporarily reserves the next parent run. If its
    // burst turns into an error before that parent exists, the error is
    // independent: a later start during its short window cannot add 10s wait.
    if (errorSupersedesSuccess
      && !this.active
      && pending.parentRun === this.parentRunRevision + 1
      && pending.parentSettled === null) {
      pending.parentRun = 0;
      pending.errorDeadline = null;
    }
    if (pending.coalesceDeadline === null || errorSupersedesSuccess) {
      pending.coalesceDeadline = fixedCoalescingDeadline(
        null,
        now,
        observation.terminal === "error" ? 100 : 450,
      );
    }
    if (observation.terminal === "error" && pending.parentRun !== 0 && pending.errorDeadline === null) {
      pending.errorDeadline = now + 10_000;
    }
    this.scheduleSubagentTimer(
      this.pendingSubagentWakeDelay(pending, now),
      pending.generation,
      pending.parentRun,
      () => this.finishSubagentCoalescing(pending.generation, pending.parentRun),
    );
  }

  private finishSubagentCoalescing(generation: number, parentRun: number): void {
    const pending = this.subagentPending;
    if (!pending || pending.generation !== generation || pending.parentRun !== parentRun) return;
    const now = this.clock.now();
    const remainingBurst = remainingErrorDeadlineMs(pending.coalesceDeadline ?? now, now);
    const errorDeadlineReached = pending.terminal === "error"
      && pending.parentRun !== 0
      && pending.errorDeadline !== null
      && remainingErrorDeadlineMs(pending.errorDeadline, now) === 0;
    // The first error's cap outranks a later semantic window. Only an exact,
    // still-active and unsettled parent can be called out as still processing.
    if (errorDeadlineReached) {
      if (this.active && parentRun === this.parentRunRevision && pending.parentSettled === null) {
        this.dispatchSubagentAttention(generation, { timeout: true });
      } else {
        this.dispatchSubagentAttention(generation, {
          parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
        });
      }
      return;
    }
    if (remainingBurst > 0) {
      this.scheduleSubagentTimer(this.pendingSubagentWakeDelay(pending, now), generation, parentRun, () => {
        this.finishSubagentCoalescing(generation, parentRun);
      });
      return;
    }
    pending.coalesceDeadline = null;

    // Settlement inside a window is intentionally deferred until the fixed
    // window closes, so same-burst terminals cannot split native attention.
    if (pending.parentSettled !== null) {
      this.dispatchSubagentAttention(generation, {
        parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
      });
      return;
    }
    // An unclaimed success grace, an independent error, or a superseded parent
    // cannot wait for a future run.
    if (parentRun === 0 || !this.active || parentRun !== this.parentRunRevision) {
      this.dispatchSubagentAttention(generation, { parentSucceeded: false });
      return;
    }
    if (pending.terminal === "success") {
      // Official hooks retain their prior log-only successful child behavior.
      if (this.officialHook) this.dispatchSubagentAttention(generation, { parentSucceeded: false });
      return;
    }

    const remainingErrorWait = remainingErrorDeadlineMs(pending.errorDeadline ?? now, now);
    if (remainingErrorWait === 0) {
      this.dispatchSubagentAttention(generation, { timeout: true });
      return;
    }
    this.scheduleSubagentTimer(remainingErrorWait, generation, parentRun, () => {
      const current = this.subagentPending;
      if (!current
        || current.terminal !== "error"
        || !this.active
        || current.parentRun !== this.parentRunRevision) return;
      this.dispatchSubagentAttention(generation, { timeout: true });
    });
  }

  /** A real parent settlement resolves only the aggregate bound to that run. */
  private flushSubagentForParentSettlement(attention: "info" | AttentionKind | "none"): boolean {
    const fenced = this.fencedParentRun === this.parentRunRevision;
    const pending = this.subagentPending;
    if (!pending || pending.parentRun !== this.parentRunRevision) return fenced;
    pending.parentSettled = this.terminal;
    if (pending.terminal === "success" && this.terminal === "error") {
      // A successful child aggregate must never hide the parent's local error.
      this.clearSubagentTimer();
      this.subagentPending = null;
      return fenced;
    }
    if (pending.coalesceDeadline !== null
      && remainingErrorDeadlineMs(pending.coalesceDeadline, this.clock.now()) > 0) {
      if (!fenced && attention !== "none") {
        this.suppressedParentAttention = {
          parentRun: pending.parentRun,
          attention,
          completed: this.completed,
          failed: this.failed,
        };
      }
      return true;
    }
    this.dispatchSubagentAttention(pending.generation, {
      parentSucceeded: pending.terminal === "success" && pending.parentSettled === "success",
    });
    return true;
  }

  private dispatchSubagentAttention(
    generation: number,
    options: { readonly parentSucceeded?: boolean; readonly timeout?: boolean },
  ): void {
    const pending = this.subagentPending;
    if (!pending || pending.generation !== generation) return;
    if (options.timeout && pending.parentRun !== 0) this.fencedParentRun = pending.parentRun;
    this.clearSubagentTimer();
    this.subagentPending = null;
    if (this.suppressedParentAttention?.parentRun === pending.parentRun) {
      this.suppressedParentAttention = null;
    }

    const content = formatSubagentAttention(
      pending.terminal,
      pending.completedDelta,
      pending.failedDelta,
      options,
      this.config.maxLabelChars,
    );
    const attention: PresenceUpdate["attention"] = content.attention;
    void this.client?.log(attention, content.body);
    // An official Pi hook suppresses only successful pi-subagent native alerts.
    if (!this.config.suppressNativeNotifications
      && !(this.officialHook && attention === "success") && shouldNotifyAttention(
      this.config.notificationPolicy,
      this.config.notifications,
      attention,
      "external",
      options.parentSucceeded === true,
    )) {
      void this.client?.notify(content.title, content.body);
    }
    if (!this.config.suppressNativeFlash
      && !(this.officialHook && attention === "success") && shouldFlashAttention(
      this.config.flashPolicy,
      this.config.flash,
      this.config.notificationPolicy,
      attention,
      "external",
      options.parentSucceeded === true,
    )) {
      void this.client?.flash();
    }
  }

  private dispatchSuppressedParentAttention(parentRun: number): void {
    const fallback = this.suppressedParentAttention;
    if (!fallback || fallback.parentRun !== parentRun) return;
    this.suppressedParentAttention = null;
    // The fallback is fixed local wording and never copies the invalidating
    // producer event.
    const content = formatLocalTurnPresentation(
      fallback.attention === "error" ? "error" : "success",
      this.config.maxLabelChars,
    );
    if (this.officialHook) return;
    void this.client?.log(fallback.attention, content.body);
    if (!this.config.suppressNativeNotifications && shouldNotifyAttention(
      this.config.notificationPolicy,
      this.config.notifications,
      fallback.attention,
      "local",
    )) {
      void this.client?.notify(content.title, content.body);
    }
    if (!this.config.suppressNativeFlash && shouldFlashAttention(
      this.config.flashPolicy,
      this.config.flash,
      this.config.notificationPolicy,
      fallback.attention,
      "local",
    )) {
      void this.client?.flash();
    }
  }

  /** Resolve elapsed boundaries synchronously before lifecycle ownership changes. */
  private reconcileElapsedSubagentAttention(): void {
    const pending = this.subagentPending;
    if (!pending) return;
    const now = this.clock.now();
    const windowElapsed = pending.coalesceDeadline !== null
      && remainingErrorDeadlineMs(pending.coalesceDeadline, now) === 0;
    const errorCapElapsed = pending.terminal === "error"
      && pending.errorDeadline !== null
      && remainingErrorDeadlineMs(pending.errorDeadline, now) === 0;
    if (!windowElapsed && !errorCapElapsed) return;
    this.finishSubagentCoalescing(pending.generation, pending.parentRun);
  }

  /** A pending active-parent error must wake for either its window or hard cap. */
  private pendingSubagentWakeDelay(pending: PendingSubagentAttention, now: number): number {
    const remainingBurst = remainingErrorDeadlineMs(pending.coalesceDeadline ?? now, now);
    if (pending.terminal !== "error" || pending.parentRun === 0 || pending.errorDeadline === null) {
      return remainingBurst;
    }
    return Math.min(remainingBurst, remainingErrorDeadlineMs(pending.errorDeadline, now));
  }

  private scheduleSubagentTimer(
    delayMs: number,
    generation: number,
    parentRun: number,
    callback: () => void,
  ): void {
    this.clearSubagentTimer();
    const timerEpoch = ++this.subagentTimerEpoch;
    const sessionEpoch = this.sessionEpoch;
    this.subagentTimer = this.clock.setTimeout(() => {
      // Timers are observer-only: every mutable identity is fenced before a
      // callback can route a notification after replacement or teardown.
      if (timerEpoch !== this.subagentTimerEpoch
        || sessionEpoch !== this.sessionEpoch
        || this.subagentPending?.generation !== generation
        || this.subagentPending?.parentRun !== parentRun) return;
      this.subagentTimer = undefined;
      callback();
    }, Math.max(0, delayMs));
    this.subagentTimer.unref?.();
  }

  private clearSubagentTimer(): void {
    if (this.subagentTimer) this.clock.clearTimeout(this.subagentTimer);
    this.subagentTimer = undefined;
    this.subagentTimerEpoch += 1;
  }

  private resetSubagentNotifications(): void {
    this.clearSubagentTimer();
    this.subagentPending = null;
    this.subagentBaseline = null;
    this.suppressedParentAttention = null;
  }

  /** A pi-subagent removal invalidates its cumulative baseline and pending burst. */
  private invalidateSubagentNotifications(): void {
    const invalidated = this.subagentPending;
    this.clearSubagentTimer();
    this.subagentPending = null;
    this.subagentBaseline = null;
    // A deferred local terminal must not be lost when the child producer
    // retracts the aggregate that had temporarily claimed it.
    if (invalidated && invalidated.parentSettled !== null) {
      this.dispatchSuppressedParentAttention(invalidated.parentRun);
    }
  }

  private renderProgress(): void {
    const next = selectProgress(this.registry.snapshot());
    if (!next) {
      if (this.shownProgress) void this.client?.clearProgress();
      this.shownProgress = false;
      return;
    }

    void this.client?.progress(
      next.progress!.value,
      formatProgressText(next, this.config.maxLabelChars),
    );
    this.shownProgress = true;
  }

  private publish(
    state: PresenceUpdate["state"],
    attention: PresenceUpdate["attention"] = "none",
  ): void {
    if (!this.sessionId) return;
    const snapshot = this.usage.snapshot();
    const event: PresenceUpdate = {
      version: 1,
      sessionId: this.sessionId,
      generation: this.generation,
      sequence: ++this.localSequence,
      source: { ...LOCAL_SOURCE },
      state,
      counts: { active: this.active ? 1 : 0, completed: this.completed, failed: this.failed },
      ...(snapshot ? { usage: snapshot } : {}),
      attention,
    };
    if (!this.registry.acceptParsed(event)) return;
    this.apply(event);
    this.emitUpdate(event);
  }

  private emitUpdate(event: PresenceUpdate): void {
    try {
      this.pi.events.emit(PI_PRESENCE_UPDATE_EVENT, event);
    } catch {
      // Process-local observers are optional.
    }
  }

  private replayRetainedLocalEvents(): void {
    const retainedLocalEvents = this.registry.snapshot().filter(
      (event) => event.source.id === LOCAL_SOURCE.id || event.source.id === TODO_SOURCE,
    );
    for (const retained of retainedLocalEvents) {
      const replay: PresenceUpdate = {
        ...retained,
        generation: this.generation,
        sequence: ++this.localSequence,
        attention: "none",
      };
      if (!this.registry.acceptParsed(replay)) continue;
      this.apply(replay);
      this.emitUpdate(replay);
    }
  }

  private emitReadyAdvertisement(sessionId: string): void {
    const advertisement = Object.freeze({
      version: 1 as const,
      sessionId,
      consumer: Object.freeze({
        id: "pi-cmux-presence",
        capabilities: Object.freeze(["cmux-status", "cmux-progress", "cmux-attention", "presence-remove-v1"]),
      }),
    });
    try {
      this.ownReadyAdvertisement = advertisement;
      this.pi.events.emit(PI_PRESENCE_READY_EVENT, advertisement);
    } catch {
      // Process-local producers are optional.
    } finally {
      this.ownReadyAdvertisement = null;
    }
  }

  private emitReadyRequest(sessionId: string): void {
    const request = Object.freeze({ version: 1 as const, sessionId });
    try {
      this.ownReadyRequest = request;
      this.pi.events.emit(PI_PRESENCE_READY_EVENT, request);
    } catch {
      // Process-local producers are optional.
    } finally {
      this.ownReadyRequest = null;
    }
  }

  private feedToolEvent(
    hookEvent: "PreToolUse" | "PostToolUse",
    event: ToolFeedEvent,
  ): void {
    if (this.officialHook || !this.sessionId) return;
    void this.client?.feed(hookEvent, this.sessionId, {
      callId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined,
      name: typeof event?.toolName === "string" ? event.toolName : undefined,
    });
  }

  private updateContextUsage(): void {
    try {
      this.usage.setContext(this.contextProvider?.getContextUsage?.());
    } catch {
      // Context usage is optional observer data.
    }
  }

  private metadata(): string {
    return aggregateMetadata(this.registry.snapshot());
  }

  private statusKey(sourceId: string): string {
    return presenceStatusKey(sourceId, this.statusScope);
  }

  private scheduleFinalClear(epoch: number): void {
    this.cancelFinalClear();
    this.clearTimer = this.clock.setTimeout(() => {
      if (epoch === this.sessionEpoch && !this.active) {
        void this.client?.clearStatus(this.statusKey(LOCAL_SOURCE.id));
      }
    }, this.config.finalClearMs);
    this.clearTimer.unref?.();
  }

  private cancelFinalClear(): void {
    if (this.clearTimer) this.clock.clearTimeout(this.clearTimer);
    this.clearTimer = undefined;
  }

  private cleanupDetachedSession(detached: DetachedSession): Promise<void> {
    const client = detached.client;
    const detachedSessionId = detached.sessionId;
    if (!client) return this.clientCloseBarrier;

    const cleanup = this.clientCloseBarrier.then(async () => {
      const budgetMs = Math.min(5_000, Math.max(750, this.config.timeoutMs * 4));
      const deadline = performance.now() + budgetMs;
      let expired = false;
      const abort = () => {
        expired = true;
        // Closing first makes all later cleanup calls no-ops and aborts active socket work.
        void client.close(0).catch(() => {});
      };
      const timer = setTimeout(abort, budgetMs);
      try {
        const bestEffort = async (operation: () => Promise<void>) => {
          if (expired) return;
          await operation().catch(() => {});
        };

        await bestEffort(() => client.clearProgress());
        for (const event of detached.retainedEvents) {
          await bestEffort(() => client.clearStatus(presenceStatusKey(event.source.id, detached.statusScope)));
        }

        if (!detached.officialHook) {
          if (this.config.nativeLifecycle) {
            await bestEffort(() => client.lifecycle("idle"));
            await bestEffort(() => client.clearPiPid());
          }
          if (this.config.metaBlock) await bestEffort(() => client.clearMeta());
          if (this.config.resumeFallback && detachedSessionId) {
            await bestEffort(() => client.clearOwnedResumeFallback(detachedSessionId));
          }
        }
      } finally {
        clearTimeout(timer);
        const remainingMs = Math.max(0, deadline - performance.now());
        await client.close(expired ? 0 : remainingMs).catch(() => {});
      }
    }).catch(() => {
      // Session teardown is best-effort and still releases the transition barrier.
    });

    this.clientCloseBarrier = cleanup;
    return cleanup;
  }
}
