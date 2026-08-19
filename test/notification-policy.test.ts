import { describe, expect, test } from "bun:test";
import {
  ExternalAttentionTransitions,
  NotificationDeduper,
  NotificationRateLimiter,
  shouldNotify,
} from "../src/notification-policy.js";

describe("notification policy module", () => {
  test("applies the complete enabled policy, origin, and severity matrix", () => {
    const matrix = [
      { policy: "errors", values: { error: [true, true], attention: [true, true], success: [false, false], info: [false, false], "long-running": [false, false] } },
      { policy: "background", values: { error: [true, true], attention: [true, true], success: [false, true], info: [false, true], "long-running": [true, true] } },
      { policy: "settled", values: { error: [true, true], attention: [true, true], success: [true, false], info: [false, false], "long-running": [false, false] } },
      { policy: "all", values: { error: [true, true], attention: [true, true], success: [true, true], info: [true, true], "long-running": [true, true] } },
      { policy: "disabled", values: { error: [false, false], attention: [false, false], success: [false, false], info: [false, false], "long-running": [false, false] } },
    ] as const;
    const origins = [["local", 0], ["external", 1]] as const;

    for (const { policy, values } of matrix) {
      for (const severity of Object.keys(values) as Array<keyof typeof values>) {
        for (const [origin, index] of origins) {
          expect(shouldNotify(policy, true, severity, origin)).toBe(values[severity][index]);
        }
      }
    }
    expect(shouldNotify("all", false, "error", "local")).toBe(false);
  });

  test("deduplicates through TTL expiry, LRU eviction, and explicit clear", () => {
    const ttl = new NotificationDeduper(100, 2);
    expect(ttl.accept("expires", 0)).toBe(true);
    expect(ttl.canAccept("expires", 99)).toBe(false);
    expect(ttl.accept("expires", 100)).toBe(true);

    const deduper = new NotificationDeduper(100, 2);
    expect(deduper.accept("first", 0)).toBe(true);
    expect(deduper.accept("second", 1)).toBe(true);
    expect(deduper.accept("first", 2)).toBe(false); // refreshes first as most recently used
    expect(deduper.accept("third", 3)).toBe(true); // evicts second
    expect(deduper.accept("second", 4)).toBe(true);
    expect(deduper.canAccept("first", 4)).toBe(true);

    deduper.clear();
    expect(deduper.canAccept("second", 4)).toBe(true);
    expect(deduper.accept("second", 4)).toBe(true);
  });

  test("keeps one first actionable kind deliverable outside a full fixed window", () => {
    const limiter = new NotificationRateLimiter(100, 2);

    expect(limiter.accept("other", 0)).toBe(true);
    expect(limiter.accept("other", 1)).toBe(true);
    expect(limiter.accept("other", 2)).toBe(false);
    expect(limiter.accept("error", 2)).toBe(true);
    expect(limiter.accept("error", 3)).toBe(false);
    expect(limiter.accept("input", 3)).toBe(true);
    expect(limiter.accept("other", 100)).toBe(true); // 0 is outside the fixed window

    limiter.clear();
    expect(limiter.accept("error", 101)).toBe(true);
  });

  test("removes and resets external attention transition state", () => {
    const transitions = new ExternalAttentionTransitions(2);

    expect(transitions.accept("first", 1, "success")).toBe(true);
    expect(transitions.accept("first", 1, "success")).toBe(false);
    expect(transitions.accept("first", 1, "error")).toBe(true);
    transitions.remove("first");
    expect(transitions.accept("first", 1, "error")).toBe(true);

    expect(transitions.accept("second", 1, "success")).toBe(true);
    expect(transitions.accept("third", 1, "success")).toBe(true); // evicts oldest first
    expect(transitions.accept("first", 1, "error")).toBe(true);

    transitions.clear();
    expect(transitions.accept("third", 1, "success")).toBe(true);
  });
});
