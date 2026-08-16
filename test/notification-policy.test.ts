import { describe, expect, test } from "bun:test";
import type { PresenceUpdate } from "../src/events.js";
import { formatSubagentAttention } from "../src/presentation.js";
import {
  fixedCoalescingDeadline,
  isAttentionEligible,
  observeSubagentTerminal,
  remainingErrorDeadlineMs,
  shouldFlashAttention,
  shouldNotifyAttention,
} from "../src/notification-policy.js";

function event(overrides: Partial<PresenceUpdate> = {}): PresenceUpdate {
  return {
    version: 1,
    sessionId: "session-1",
    generation: 1,
    sequence: 1,
    source: { id: "pi-subagent", label: "Untrusted descriptive label", kind: "agent-group" },
    state: "success",
    counts: { active: 0, completed: 0, failed: 0 },
    attention: "none",
    ...overrides,
  };
}

describe("notification policy", () => {
  test("calculates deltas, preserves success through a following error, and ignores no-delta/cancelled updates", () => {
    const first = observeSubagentTerminal(null, event({ attention: "none" }));
    const success = observeSubagentTerminal(first.baseline, event({ sequence: 2, counts: { active: 0, completed: 2, failed: 0 }, attention: "success" }));
    expect(success).toMatchObject({ terminal: "success", completedDelta: 2, failedDelta: 0 });
    const error = observeSubagentTerminal(success.baseline, event({ sequence: 3, state: "error", counts: { active: 0, completed: 3, failed: 1 }, attention: "error" }));
    expect(error).toMatchObject({ terminal: "error", completedDelta: 1, failedDelta: 1 });
    const noDelta = observeSubagentTerminal(error.baseline, event({ sequence: 4, state: "error", counts: { active: 0, completed: 3, failed: 1 }, attention: "error" }));
    expect(noDelta.terminal).toBeNull();
    const cancelled = observeSubagentTerminal(noDelta.baseline, event({ sequence: 5, state: "cancelled", counts: { active: 0, completed: 3, failed: 1, cancelled: 1 }, attention: "error" }));
    expect(cancelled.terminal).toBeNull();
  });

  test("resets safely on decreases and treats first non-none attention as unknown rather than history", () => {
    const first = observeSubagentTerminal(null, event({ counts: { active: 0, completed: 9, failed: 4 }, attention: "error" }));
    expect(first).toMatchObject({ terminal: "error", unknownCount: true, completedDelta: 0, failedDelta: 0 });
    const decreased = observeSubagentTerminal(first.baseline, event({ sequence: 2, counts: { active: 0, completed: 1, failed: 0 }, attention: "error" }));
    expect(decreased).toMatchObject({ terminal: null, reset: true });
    const generation = observeSubagentTerminal(decreased.baseline, event({ generation: 2, sequence: 1, counts: { active: 0, completed: 9, failed: 9 }, attention: "none" }));
    expect(generation).toMatchObject({ terminal: null, generationChanged: true, unknownCount: false });
  });

  test("calculates fixed deadlines and timeout presentation without sleeping", () => {
    const firstDeadline = fixedCoalescingDeadline(null, 1_000, 100);
    expect(firstDeadline).toBe(1_100);
    expect(fixedCoalescingDeadline(firstDeadline, 1_070, 100)).toBe(1_100);
    expect(remainingErrorDeadlineMs(10_000, 9_900)).toBe(100);
    expect(remainingErrorDeadlineMs(10_000, 10_001)).toBe(0);
    expect(formatSubagentAttention("error", 2, 1, { timeout: true }, 96)).toMatchObject({
      title: "Subagent failed",
      body: "2 completed · 1 failed · Parent is processing results",
    });
    expect(formatSubagentAttention("success", 0, 0, { parentSucceeded: true }, 96)).toMatchObject({
      title: "Pi response ready",
      body: "Subagent task completed",
    });
    expect(formatSubagentAttention("success", 3, 0, { parentSucceeded: true }, 96).body).toBe("Subagents: 3 completed");
  });

  test("applies exact global notify and flash policy semantics", () => {
    expect(shouldNotifyAttention("errors", true, "success", "external")).toBe(false);
    expect(shouldNotifyAttention("errors", true, "error", "local")).toBe(true);
    expect(shouldNotifyAttention("background", true, "success", "external")).toBe(true);
    expect(shouldNotifyAttention("background", true, "success", "local")).toBe(false);
    expect(shouldNotifyAttention("background", true, "success", "local", true)).toBe(true);
    expect(shouldNotifyAttention("settled", true, "success", "local")).toBe(true);
    expect(shouldNotifyAttention("settled", true, "error", "local")).toBe(true);
    expect(shouldNotifyAttention("settled", true, "info", "external")).toBe(false);
    expect(shouldNotifyAttention("settled", true, "success", "external")).toBe(false);
    expect(shouldNotifyAttention("settled", true, "success", "external", true)).toBe(true);
    expect(shouldNotifyAttention("settled", true, "error", "external")).toBe(true);
    expect(shouldNotifyAttention("settled", false, "error", "local")).toBe(false);
    expect(shouldNotifyAttention("all", true, "info", "local")).toBe(true);
    expect(shouldNotifyAttention("disabled", true, "error", "external")).toBe(false);
    expect(shouldNotifyAttention("all", false, "error", "external")).toBe(false);
    expect(isAttentionEligible("background", "success", "local")).toBe(false);
    expect(isAttentionEligible("background", "success", "external")).toBe(true);
    expect(shouldFlashAttention("errors", true, "disabled", "success", "external")).toBe(false);
    expect(shouldFlashAttention("errors", true, "disabled", "error", "local")).toBe(true);
    expect(shouldFlashAttention("attention", true, "all", "success", "external")).toBe(true);
    expect(shouldFlashAttention("attention", true, "errors", "success", "external")).toBe(false);
    expect(shouldFlashAttention("attention", true, "disabled", "error", "external")).toBe(false);
    // Notification capability is independent from configured error flash.
    expect(shouldFlashAttention("errors", true, "background", "error", "local")).toBe(true);
    expect(shouldFlashAttention("attention", false, "all", "error", "external")).toBe(false);
  });
});
