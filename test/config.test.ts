import { describe, expect, test } from "bun:test";
import { resolvePresenceConfig } from "../src/config.js";

describe("resolvePresenceConfig", () => {
  test("uses documented defaults", () => {
    expect(resolvePresenceConfig({})).toEqual({
      enabled: true,
      timeoutMs: 1_000,
      maxQueue: 16,
      progress: true,
      notifications: true,
      flash: true,
      notificationPolicy: "background",
      flashPolicy: "errors",
      subagentChildProfile: false,
      suppressNativeNotifications: false,
      suppressNativeFlash: false,
      log: false,
      sidebar: true,
      nativeLifecycle: true,
      feed: false,
      metaBlock: false,
      autoTitle: false,
      resumeFallback: false,
      finalClearMs: 1_500,
      maxLabelChars: 96,
    });
  });

  test.each(["1", "true", "yes", "on"])("parses truthy booleans: %s", (value) => {
    expect(resolvePresenceConfig({ PI_CMUX_PRESENCE_LOG: ` ${value.toUpperCase()} ` }).log).toBe(true);
  });

  test.each(["0", "false", "no", "off"])("parses falsy booleans: %s", (value) => {
    expect(resolvePresenceConfig({ PI_CMUX_PRESENCE_ENABLED: ` ${value.toUpperCase()} ` }).enabled).toBe(false);
  });

  test("falls back for malformed booleans", () => {
    expect(resolvePresenceConfig({
      PI_CMUX_PRESENCE_ENABLED: "sometimes",
      PI_CMUX_PRESENCE_NOTIFICATIONS: "",
      PI_CMUX_PRESENCE_FLASH: "2",
    })).toMatchObject({ enabled: true, notifications: true, flash: true });
  });

  test.each([
    ["PI_CMUX_PRESENCE_NOTIFY_POLICY", "notificationPolicy", "errors"],
    ["PI_CMUX_PRESENCE_NOTIFY_POLICY", "notificationPolicy", "background"],
    ["PI_CMUX_PRESENCE_NOTIFY_POLICY", "notificationPolicy", "settled"],
    ["PI_CMUX_PRESENCE_NOTIFY_POLICY", "notificationPolicy", "all"],
    ["PI_CMUX_PRESENCE_NOTIFY_POLICY", "notificationPolicy", "disabled"],
    ["PI_CMUX_PRESENCE_FLASH_POLICY", "flashPolicy", "errors"],
    ["PI_CMUX_PRESENCE_FLASH_POLICY", "flashPolicy", "attention"],
    ["PI_CMUX_PRESENCE_FLASH_POLICY", "flashPolicy", "disabled"],
  ] as const)("%s maps to %s=%s", (envKey, configKey, value) => {
    expect(resolvePresenceConfig({ [envKey]: ` ${value.toUpperCase()} ` })[configKey]).toBe(value);
  });

  test("parses only the public policy enums and keeps legacy false as a kill switch", () => {
    expect(resolvePresenceConfig({
      PI_CMUX_PRESENCE_NOTIFY_POLICY: " ALL ",
      PI_CMUX_PRESENCE_FLASH_POLICY: "attention",
      PI_CMUX_PRESENCE_NOTIFICATIONS: "false",
      PI_CMUX_PRESENCE_FLASH: "false",
    })).toMatchObject({
      notificationPolicy: "all",
      flashPolicy: "attention",
      notifications: false,
      flash: false,
    });
    // A legacy true never overrides an explicit modern policy.
    expect(resolvePresenceConfig({
      PI_CMUX_PRESENCE_NOTIFY_POLICY: "disabled",
      PI_CMUX_PRESENCE_FLASH_POLICY: "disabled",
      PI_CMUX_PRESENCE_NOTIFICATIONS: "true",
      PI_CMUX_PRESENCE_FLASH: "true",
    })).toMatchObject({ notificationPolicy: "disabled", flashPolicy: "disabled" });
    expect(resolvePresenceConfig({
      PI_CMUX_PRESENCE_NOTIFY_POLICY: "foreground",
      PI_CMUX_PRESENCE_FLASH_POLICY: "all",
    })).toMatchObject({ notificationPolicy: "background", flashPolicy: "errors" });
  });

  test("recognizes only the exact reviewed child profile and exact per-channel disables", () => {
    expect(resolvePresenceConfig({
      PI_CMUX_PROFILE: "subagent-child-v1",
      PI_CMUX_NOTIFY_LEVEL: "disabled",
      PI_CMUX_SIDEBAR_FLASH: "disabled",
      PI_CMUX_SIDEBAR_SOURCE: "pi-subagent-child",
      PI_CMUX_PRESENCE_NOTIFY_POLICY: "all",
      PI_CMUX_PRESENCE_FLASH_POLICY: "attention",
      PI_CMUX_PRESENCE_NOTIFICATIONS: "false",
      PI_CMUX_PRESENCE_FLASH: "false",
    })).toMatchObject({
      notificationPolicy: "all",
      flashPolicy: "attention",
      notifications: false,
      flash: false,
      subagentChildProfile: true,
      suppressNativeNotifications: true,
      suppressNativeFlash: true,
    });
    // Partial and malformed profiles use ordinary policy semantics; the source
    // label is not identity or an implicit child-profile signal.
    expect(resolvePresenceConfig({
      PI_CMUX_PROFILE: "subagent-child-v1",
      PI_CMUX_NOTIFY_LEVEL: "disabled",
    })).toMatchObject({
      subagentChildProfile: true,
      suppressNativeNotifications: true,
      suppressNativeFlash: false,
    });
    expect(resolvePresenceConfig({
      PI_CMUX_PROFILE: "subagent-child-v1 ",
      PI_CMUX_NOTIFY_LEVEL: "disabled",
      PI_CMUX_SIDEBAR_FLASH: "DISABLED",
      PI_CMUX_SIDEBAR_SOURCE: "pi-subagent-child",
    })).toMatchObject({
      subagentChildProfile: false,
      suppressNativeNotifications: false,
      suppressNativeFlash: false,
    });
    expect(resolvePresenceConfig({
      PI_CMUX_NOTIFY_LEVEL: "disabled",
      PI_CMUX_SIDEBAR_FLASH: "disabled",
      PI_CMUX_SIDEBAR_SOURCE: "pi-subagent-child",
    })).toMatchObject({
      subagentChildProfile: false,
      suppressNativeNotifications: false,
      suppressNativeFlash: false,
    });
  });

  test.each([
    ["PI_CMUX_PRESENCE_TIMEOUT_MS", "timeoutMs", 100, 30_000, 1_000],
    ["PI_CMUX_PRESENCE_MAX_QUEUE", "maxQueue", 1, 128, 16],
    ["PI_CMUX_PRESENCE_FINAL_CLEAR_MS", "finalClearMs", 0, 60_000, 1_500],
    ["PI_CMUX_PRESENCE_MAX_LABEL_CHARS", "maxLabelChars", 16, 256, 96],
  ] as const)("bounds %s", (envKey, configKey, min, max, fallback) => {
    expect(resolvePresenceConfig({ [envKey]: String(min) })[configKey]).toBe(min);
    expect(resolvePresenceConfig({ [envKey]: String(max) })[configKey]).toBe(max);
    expect(resolvePresenceConfig({ [envKey]: String(min - 1) })[configKey]).toBe(fallback);
    expect(resolvePresenceConfig({ [envKey]: String(max + 1) })[configKey]).toBe(fallback);
    expect(resolvePresenceConfig({ [envKey]: ` ${min} ` })[configKey]).toBe(min);
    for (const invalid of ["-1", "1.5", "NaN", "Infinity", " "]) {
      expect(resolvePresenceConfig({ [envKey]: invalid })[configKey]).toBe(fallback);
    }
  });
});
