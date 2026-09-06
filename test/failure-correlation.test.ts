import { expect, test } from "bun:test";
import { FailureCorrelation } from "../src/failure-correlation.js";

const state = (sequence: number, acceptedAt: number, generation = 1, source = "subagent") => ({ source, generation, sequence, acceptedAt, kind: "state" as const });
const terminal = (sequence: number, acceptedAt: number, eventId = sequence, generation = 1, source = "subagent") => ({ source, generation, sequence, acceptedAt, eventId, kind: "terminal" as const });

test("correlates adjacent state then terminal within the 100ms acceptance horizon", () => {
  const correlation = new FailureCorrelation();
  const stateKey = correlation.accept(state(1, 1_000));
  expect(correlation.accept(terminal(2, 1_011))).toBe(stateKey);
});

test("correlates adjacent terminal then state within the 100ms acceptance horizon", () => {
  const correlation = new FailureCorrelation();
  const terminalKey = correlation.accept(terminal(1, 1_000));
  expect(correlation.accept(state(2, 1_011))).toBe(terminalKey);
});

test("keeps representations independent beyond the correlation horizon", () => {
  const correlation = new FailureCorrelation();
  const stateKey = correlation.accept(state(1, 1_000));
  expect(correlation.accept(terminal(2, 1_101))).not.toBe(stateKey);
});

test("requires same generation and exactly adjacent accepted sequences", () => {
  const correlation = new FailureCorrelation();
  const stateKey = correlation.accept(state(1, 1_000));
  expect(correlation.accept(terminal(3, 1_001))).not.toBe(stateKey);

  const terminalKey = correlation.accept(terminal(4, 1_002));
  expect(correlation.accept(state(5, 1_003, 2))).not.toBe(terminalKey);
});

test("an intervening same-source event is an ambiguity boundary", () => {
  const correlation = new FailureCorrelation();
  const stateKey = correlation.accept(state(1, 1_000));
  correlation.boundary("subagent", 1);
  expect(correlation.accept(terminal(3, 1_001))).not.toBe(stateKey);
});

test("a newest terminal fallback uses its own uncommitted key, not an older admitted key", () => {
  const correlation = new FailureCorrelation();
  const firstTerminal = correlation.accept(terminal(1, 1_000, 1));
  const newestTerminal = correlation.accept(terminal(2, 1_001, 2));
  expect(correlation.accept(state(3, 1_002))).toBe(newestTerminal);
  expect(newestTerminal).not.toBe(firstTerminal);

  const firstState = correlation.accept(state(4, 1_003));
  const newestState = correlation.accept(state(5, 1_004));
  expect(correlation.accept(terminal(6, 1_005, 3))).toBe(newestState);
  expect(newestState).not.toBe(firstState);
});

test("bounds unmatched candidates across sources", () => {
  const correlation = new FailureCorrelation(100, 2);
  const first = correlation.accept(state(1, 1_000, 1, "one"));
  correlation.accept(state(1, 1_001, 1, "two"));
  correlation.accept(state(1, 1_002, 1, "three"));
  expect(correlation.accept(terminal(2, 1_003, 1, 1, "one"))).not.toBe(first);
});

test("source resets and cleanup are correlation boundaries", () => {
  const correlation = new FailureCorrelation();
  const first = correlation.accept(state(1, 1_000));
  correlation.accept(state(1, 1_001, 2));
  expect(correlation.accept(terminal(2, 1_002, 1, 2))).not.toBe(first);

  const second = correlation.accept(state(3, 1_003, 2));
  correlation.clear();
  expect(correlation.accept(terminal(4, 1_004, 2, 2))).not.toBe(second);
});
