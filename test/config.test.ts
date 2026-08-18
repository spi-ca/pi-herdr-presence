import { expect, test } from "bun:test";
import { resolvePresenceConfig, resolvePresenceMode } from "../src/config.js";
test("configuration has bounded defaults",()=>{const config=resolvePresenceConfig();expect(config.timeoutMs).toBeGreaterThan(0);expect(config.maxQueue).toBeGreaterThan(0);});
test("configuration defaults to metadata",()=>expect(resolvePresenceConfig().metadata).toBe(true));
test("automatic mode activates only from an exact managed-hook result",()=>{
  const config=resolvePresenceConfig({});
  expect(config.mode).toBe("auto");
  expect(resolvePresenceMode(config,"absent")).toBe("standalone");
  expect(resolvePresenceMode(config,"present")).toBe("companion");
  expect(resolvePresenceMode(config,"unknown")).toBe("disabled");
  expect(resolvePresenceMode(resolvePresenceConfig({PI_HERDR_PRESENCE_MODE:"standalone"}),"present")).toBe("disabled");
  expect(resolvePresenceMode(resolvePresenceConfig({PI_HERDR_PRESENCE_MODE:"companion"}),"absent")).toBe("disabled");
  expect(resolvePresenceConfig({PI_HERDR_PRESENCE_SOLE_REPORTER:"1"}).soleReporter).toBe(true);
});
test("configuration has final clear bound",()=>expect(resolvePresenceConfig().finalClearMs).toBeGreaterThanOrEqual(0));
test("configuration parses legacy notification settings",()=>expect(["errors","background","settled","all","disabled"]).toContain(resolvePresenceConfig().notificationPolicy));
