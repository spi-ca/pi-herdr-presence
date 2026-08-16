import type { PresenceUpdate } from "./events.js";

/** Exact producer identity; labels and kinds are descriptive, never routing authority. */
export const PI_SUBAGENT_SOURCE_ID = "pi-subagent";

export type NotificationPolicy = "errors" | "background" | "settled" | "all" | "disabled";
export type FlashPolicy = "errors" | "attention" | "disabled";
export type AttentionKind = "success" | "error";
export type AttentionOrigin = "local" | "external";

export interface SubagentTerminalBaseline {
  readonly generation: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

export interface SubagentObservation {
  readonly baseline: SubagentTerminalBaseline;
  readonly terminal: AttentionKind | null;
  readonly completedDelta: number;
  readonly failedDelta: number;
  /** Counts went backwards: discard any aggregate burst. */
  readonly reset: boolean;
  /** The generation changed; a non-none first update is only an unknown live alert. */
  readonly generationChanged: boolean;
  /** A first non-none update has no trustworthy historical delta. */
  readonly unknownCount: boolean;
}

function baselineFor(event: PresenceUpdate): SubagentTerminalBaseline {
  return {
    generation: event.generation,
    completed: event.counts.completed,
    failed: event.counts.failed,
    cancelled: event.counts.cancelled ?? 0,
  };
}

function terminalFor(attention: PresenceUpdate["attention"]): AttentionKind | null {
  if (attention === "error") return "error";
  return attention === "success" || attention === "info" ? "success" : null;
}

/**
 * Interpret pi-subagent's cumulative counters. Only the exact source is
 * eligible, and cancellation is never an attention signal. A non-none first
 * update can still be a live terminal, but intentionally carries no history.
 */
export function observeSubagentTerminal(
  previous: SubagentTerminalBaseline | null,
  event: PresenceUpdate,
): SubagentObservation {
  const baseline = baselineFor(event);
  const noAttention = event.state === "cancelled" ? null : terminalFor(event.attention);
  if (event.source.id !== PI_SUBAGENT_SOURCE_ID) {
    return { baseline, terminal: null, completedDelta: 0, failedDelta: 0, reset: false, generationChanged: false, unknownCount: false };
  }

  if (previous === null || previous.generation !== event.generation) {
    // A replay with none only establishes its baseline. A non-none first event
    // may be live, so preserve a generic (unknown-count) signal without
    // treating its cumulative totals as new work.
    return {
      baseline,
      terminal: noAttention,
      completedDelta: 0,
      failedDelta: 0,
      reset: false,
      generationChanged: previous !== null,
      unknownCount: noAttention !== null,
    };
  }

  const completedDelta = event.counts.completed - previous.completed;
  const failedDelta = event.counts.failed - previous.failed;
  const cancelledDelta = (event.counts.cancelled ?? 0) - previous.cancelled;
  if (completedDelta < 0 || failedDelta < 0 || cancelledDelta < 0) {
    return { baseline, terminal: null, completedDelta: 0, failedDelta: 0, reset: true, generationChanged: false, unknownCount: false };
  }

  if (noAttention === null) {
    return { baseline, terminal: null, completedDelta: 0, failedDelta: 0, reset: false, generationChanged: false, unknownCount: false };
  }

  const terminal = noAttention === "error"
    ? failedDelta > 0 ? "error" : null
    : completedDelta > 0 ? "success" : null;
  return {
    baseline,
    terminal,
    completedDelta: terminal === null ? 0 : completedDelta,
    failedDelta: terminal === null ? 0 : failedDelta,
    reset: false,
    generationChanged: false,
    unknownCount: false,
  };
}

/** Preserve the first event's fixed semantic window instead of sliding it. */
export function fixedCoalescingDeadline(
  existingDeadline: number | null,
  now: number,
  windowMs: number,
): number {
  return existingDeadline ?? now + windowMs;
}

/** Pure monotonic timeout arithmetic keeps timer tests free of long sleeps. */
export function remainingErrorDeadlineMs(deadline: number, now: number): number {
  return Math.max(0, deadline - now);
}

/** Whether an attention signal is eligible under the selected modern policy. */
export function isAttentionEligible(
  policy: NotificationPolicy,
  attention: PresenceUpdate["attention"],
  origin: AttentionOrigin,
  mergedWithSubagent = false,
): boolean {
  if (policy === "disabled" || attention === "none" || attention === undefined) return false;
  if (policy === "errors") return attention === "error";
  if (policy === "settled") {
    // Generic external completion is intentionally quiet. An exact merged
    // parent/subagent success represents a finalized local completion.
    return attention === "error"
      || (attention === "success" && (origin === "local" || mergedWithSubagent));
  }
  if (policy === "all") return true;
  // background: external producers retain their non-none attention; local
  // success is only useful as the merged parent/subagent completion.
  return origin === "external" || attention === "error" || mergedWithSubagent;
}

export function shouldNotifyAttention(
  policy: NotificationPolicy,
  legacyNotificationsEnabled: boolean,
  attention: PresenceUpdate["attention"],
  origin: AttentionOrigin,
  mergedWithSubagent = false,
): boolean {
  return legacyNotificationsEnabled
    && isAttentionEligible(policy, attention, origin, mergedWithSubagent);
}

export function shouldFlashAttention(
  policy: FlashPolicy,
  legacyFlashEnabled: boolean,
  notificationPolicy: NotificationPolicy,
  attention: PresenceUpdate["attention"],
  origin: AttentionOrigin,
  mergedWithSubagent = false,
): boolean {
  if (!legacyFlashEnabled || policy === "disabled") return false;
  // Error flash is independently configured; it must not be coupled to the
  // legacy notification capability/kill switch.
  if (policy === "errors") return attention === "error";
  return isAttentionEligible(notificationPolicy, attention, origin, mergedWithSubagent);
}
