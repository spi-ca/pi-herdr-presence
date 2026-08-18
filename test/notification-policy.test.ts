import { expect, test } from "bun:test";
import { ExternalAttentionTransitions } from "../src/notification-policy.js";

test("external V2 transition fence ignores duplicate semantic edges", () => {
  const fence = new ExternalAttentionTransitions();
  expect(fence.accept("subagent", 1, "success")).toBe(true);
  expect(fence.accept("subagent", 1, "success")).toBe(false);
  expect(fence.accept("subagent", 1, "error")).toBe(true);
});
