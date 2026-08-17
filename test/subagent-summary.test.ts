import { expect, test } from "bun:test";
import { parseSubagentSummary, SubagentSummaryFence } from "../src/subagent-summary.js";
import { metadata } from "../src/presentation.js";

const canonicalSummary = {
  version: 1 as const, sessionId: "summary-session", generation: 7, sequence: 9, source: { id: "pi-subagent" },
  active: [
    { id: "run-1", agent: "worker", status: "running" as const, category: "active" as const, startedAt: 1 },
    { id: "run-2", agent: "worker", status: "cancelling" as const, category: "cancelling" as const, startedAt: 2 },
  ],
  waiting: { category: "queued" as const, count: 3 },
  terminal: { id: "run-0", agent: "worker", status: "failed" as const, completedAt: 3 },
  omitted: 4,
};
const invalidCanonicalSummaries: unknown[] = [
  { ...canonicalSummary, unexpected: true },
  { ...canonicalSummary, active: [{ ...canonicalSummary.active[0], status: "waiting" }] },
  { ...canonicalSummary, active: [{ ...canonicalSummary.active[0], category: "cancelling" }] },
  { ...canonicalSummary, waiting: { category: "blocked", count: 1 } },
  { ...canonicalSummary, waiting: { category: "queued", count: 1_000_001 } },
  { ...canonicalSummary, terminal: { ...canonicalSummary.terminal, status: "error" } },
  { ...canonicalSummary, active: [{ ...canonicalSummary.active[0], startedAt: Number.MAX_SAFE_INTEGER + 1 }] },
  { ...canonicalSummary, terminal: { ...canonicalSummary.terminal, completedAt: -1 } },
  { ...canonicalSummary, terminal: undefined },
  { ...canonicalSummary, omitted: 1_000_001 },
  { ...canonicalSummary, sessionId: "bad\nsummary" },
];

test("strict subagent summary parses the canonical companion fixtures", () => {
  expect(parseSubagentSummary(canonicalSummary)).toEqual(canonicalSummary);
  expect(parseSubagentSummary({ ...canonicalSummary, terminal: { ...canonicalSummary.terminal, completedAt: Number.MAX_SAFE_INTEGER } })?.terminal?.completedAt).toBe(Number.MAX_SAFE_INTEGER);
  for (const invalid of invalidCanonicalSummaries) expect(parseSubagentSummary(invalid)).toBeNull();
  expect(parseSubagentSummary({ ...canonicalSummary, active: Array.from({ length: 9 }, () => canonicalSummary.active[0]) })).toBeNull();
  expect(parseSubagentSummary(new Proxy({}, { get() { throw new Error("no getter execution"); } }))).toBeNull();
});

test("summary shares the accepted update/remove fence and cannot replay a tombstone", () => {
  const fence = new SubagentSummaryFence();
  expect(fence.acceptSummary(parseSubagentSummary(canonicalSummary)!)).toBe(false);
  fence.recordUpdate({ version: 1, sessionId: "summary-session", generation: 7, sequence: 9, source: { id: "pi-subagent", label: "Subagents", kind: "aggregate" }, state: "running", counts: { active: 1, completed: 0, failed: 0 } });
  expect(fence.acceptSummary(parseSubagentSummary(canonicalSummary)!)).toBe(true);
  expect(fence.acceptSummary(parseSubagentSummary(canonicalSummary)!)).toBe(false);
  fence.recordRemove({ version: 1, sessionId: "summary-session", generation: 7, sequence: 10, source: { id: "pi-subagent" } });
  expect(fence.acceptSummary(parseSubagentSummary(canonicalSummary)!)).toBe(false);
  expect(fence.acceptSummary(parseSubagentSummary({ ...canonicalSummary, sequence: 10 })!)).toBe(false);
});

test("parent metadata keeps only safe count/category/terminal summary", () => {
  const parsed = parseSubagentSummary(canonicalSummary)!;
  const rendered = metadata([], "working", 96, parsed).tokens;
  expect(rendered).toMatchObject({ subagents: "6", subagent_wait: "queued:3", subagent_error: "1", subagent_terminal: "failed" });
  expect(JSON.stringify(rendered)).not.toContain("run-");
  expect(JSON.stringify(rendered)).not.toContain("worker");
});

test("only failed summary terminals set the error metadata", () => {
  for (const status of ["completed", "cancelled"] as const) {
    const parsed = parseSubagentSummary({ ...canonicalSummary, terminal: { ...canonicalSummary.terminal, status } })!;
    const rendered = metadata([], "working", 96, parsed).tokens;
    expect(rendered).toMatchObject({ subagent_error: null, subagent_terminal: status });
  }
});
