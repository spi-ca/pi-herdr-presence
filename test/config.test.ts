import { describe, expect, test } from "bun:test";
import { resolvePresenceConfig, resolvePresenceMode } from "../src/config.js";

describe("configuration module", () => {
  test("uses documented defaults", () => {
    expect(resolvePresenceConfig({})).toEqual({
      enabled: true,
      soleReporter: false,
      mode: "auto",
      timeoutMs: 1_000,
      maxQueue: 16,
      notifications: true,
      notificationPolicy: "errors",
      metadata: true,
      finalClearMs: 1_500,
      maxLabelChars: 96,
      longRunningMs: 30_000,
    });
  });

  test("accepts supported boolean spellings and falls back for invalid values", () => {
    const cases = [
      ["PI_HERDR_PRESENCE_ENABLED", "1", "enabled", true],
      ["PI_HERDR_PRESENCE_ENABLED", "OFF", "enabled", false],
      ["PI_HERDR_PRESENCE_SOLE_REPORTER", " yes ", "soleReporter", true],
      ["PI_HERDR_PRESENCE_NOTIFICATIONS", "false", "notifications", false],
      ["PI_HERDR_PRESENCE_METADATA", "on", "metadata", true],
      ["PI_HERDR_PRESENCE_ENABLED", "perhaps", "enabled", true],
    ] as const;

    for (const [name, value, property, expected] of cases) {
      expect(resolvePresenceConfig({ [name]: value })[property]).toBe(expected);
    }
  });

  test("accepts only bounded integer settings", () => {
    const cases = [
      ["PI_HERDR_PRESENCE_TIMEOUT_MS", "100", "timeoutMs", 100],
      ["PI_HERDR_PRESENCE_TIMEOUT_MS", "30000", "timeoutMs", 30_000],
      ["PI_HERDR_PRESENCE_TIMEOUT_MS", "99", "timeoutMs", 1_000],
      ["PI_HERDR_PRESENCE_TIMEOUT_MS", "30001", "timeoutMs", 1_000],
      ["PI_HERDR_PRESENCE_TIMEOUT_MS", "1.5", "timeoutMs", 1_000],
      ["PI_HERDR_PRESENCE_MAX_QUEUE", "1", "maxQueue", 1],
      ["PI_HERDR_PRESENCE_MAX_QUEUE", "128", "maxQueue", 128],
      ["PI_HERDR_PRESENCE_MAX_QUEUE", "0", "maxQueue", 16],
      ["PI_HERDR_PRESENCE_FINAL_CLEAR_MS", "0", "finalClearMs", 0],
      ["PI_HERDR_PRESENCE_FINAL_CLEAR_MS", "60001", "finalClearMs", 1_500],
      ["PI_HERDR_PRESENCE_MAX_LABEL_CHARS", "16", "maxLabelChars", 16],
      ["PI_HERDR_PRESENCE_MAX_LABEL_CHARS", "257", "maxLabelChars", 96],
      ["PI_HERDR_PRESENCE_LONG_RUNNING_MS", "1000", "longRunningMs", 1_000],
      ["PI_HERDR_PRESENCE_LONG_RUNNING_MS", "300001", "longRunningMs", 30_000],
    ] as const;

    for (const [name, value, property, expected] of cases) {
      expect(resolvePresenceConfig({ [name]: value })[property]).toBe(expected);
    }
  });

  test("normalizes accepted modes and notification policies and rejects unknown values", () => {
    const cases = [
      ["PI_HERDR_PRESENCE_MODE", " COMPANION ", "mode", "companion"],
      ["PI_HERDR_PRESENCE_MODE", "invalid", "mode", "auto"],
      ["PI_HERDR_PRESENCE_NOTIFY_POLICY", "SETTLED", "notificationPolicy", "settled"],
      ["PI_HERDR_PRESENCE_NOTIFY_POLICY", "invalid", "notificationPolicy", "errors"],
    ] as const;

    for (const [name, value, property, expected] of cases) {
      expect(resolvePresenceConfig({ [name]: value })[property]).toBe(expected);
    }
  });

  test("selects modes only when the managed-hook result permits them", () => {
    const cases = [
      [true, "auto", "absent", "standalone"],
      [true, "auto", "present", "companion"],
      [true, "auto", "unknown", "disabled"],
      [true, "standalone", "absent", "standalone"],
      [true, "standalone", "present", "disabled"],
      [true, "companion", "present", "companion"],
      [true, "companion", "absent", "disabled"],
      [true, "disabled", "present", "disabled"],
      [false, "auto", "absent", "disabled"],
    ] as const;

    for (const [enabled, mode, official, expected] of cases) {
      const config = resolvePresenceConfig({
        PI_HERDR_PRESENCE_ENABLED: enabled ? "true" : "false",
        PI_HERDR_PRESENCE_MODE: mode,
      });
      expect(resolvePresenceMode(config, official)).toBe(expected);
    }
  });
});
