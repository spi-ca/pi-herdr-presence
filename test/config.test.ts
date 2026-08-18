import { expect, test } from "bun:test";
import { resolvePresenceConfig } from "../src/config.js";
test("configuration has bounded defaults",()=>{const config=resolvePresenceConfig();expect(config.timeoutMs).toBeGreaterThan(0);expect(config.maxQueue).toBeGreaterThan(0);});
test("configuration defaults to metadata",()=>expect(resolvePresenceConfig().metadata).toBe(true));
test("local reporter requires explicit sole-reporter opt-in",()=>{
  expect(resolvePresenceConfig({}).soleReporter).toBe(false);
  expect(resolvePresenceConfig({PI_HERDR_PRESENCE_SOLE_REPORTER:"1"}).soleReporter).toBe(true);
  expect(resolvePresenceConfig({PI_HERDR_PRESENCE_SOLE_REPORTER:"unexpected"}).soleReporter).toBe(false);
});
test("configuration has final clear bound",()=>expect(resolvePresenceConfig().finalClearMs).toBeGreaterThanOrEqual(0));
test("configuration parses legacy notification settings",()=>expect(["errors","background","settled","all","disabled"]).toContain(resolvePresenceConfig().notificationPolicy));
