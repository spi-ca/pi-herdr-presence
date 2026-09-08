import { expect, test } from "bun:test";
import { TodoProgressAdapter } from "../src/todo.js";
import { UsageTracker } from "../src/usage.js";

const tools = [{ name: "todo", sourceInfo: { path: "/todo", source: "project", scope: "project", origin: "top" } }];
const accept = (params: Record<string, unknown>, error?: unknown) => new TodoProgressAdapter().accept(
  { toolName: "todo", isError: false, details: { action: "list", params, ...(error === undefined ? {} : { error }), nextId: 1, tasks: [] } },
  tools,
  1,
  1,
);

test("todo V2 projection retains aggregate progress", () => {
  const result = new TodoProgressAdapter().accept(
    { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 3, tasks: [{ id: 1, status: "completed", subject: "secret" }, { id: 2, status: "pending" }] } },
    tools,
    1,
    1,
  );
  expect(result).toMatchObject({ version: 2, source: "todo", progress: { completed: 1, total: 2 } });
});

test("todo V2 projection omits task text", () => {
  const result = new TodoProgressAdapter().accept(
    { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "pending", subject: "secret" }] } },
    tools,
    1,
    1,
  );
  expect(JSON.stringify(result)).not.toContain("secret");
});

test("todo rejects duplicate IDs", () => {
  expect(new TodoProgressAdapter().accept(
    { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 3, tasks: [{ id: 1, status: "pending" }, { id: 1, status: "pending" }] } },
    tools,
    1,
    1,
  )).toBeNull();
});

test("todo owner resets at a root-session boundary", () => {
  const adapter = new TodoProgressAdapter();
  const event = { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [{ id: 1, status: "pending" }] } };
  const ownerA = [{ name: "todo", sourceInfo: { path: "/a/todo", source: "project", scope: "project", origin: "top" } }];
  const ownerB = [{ name: "todo", sourceInfo: { path: "/b/todo", source: "project", scope: "project", origin: "top" } }];
  expect(adapter.accept(event, ownerA, 1, 1)).not.toBeNull();
  expect(adapter.accept(event, ownerB, 1, 2)).toBeNull();
  adapter.reset();
  expect(adapter.accept(event, ownerB, 2, 1)).toMatchObject({ generation: 2, sequence: 1, source: "todo" });
});

test("todo bounds params and error as one identity-safe traversal", () => {
  const atLimit = Array.from({ length: 4 }, () => Array(254).fill(null));
  expect(accept({ left: null, right: null, values: atLimit })).not.toBeNull();
  atLimit[0]!.push(null);
  expect(accept({ left: null, right: null, values: atLimit })).toBeNull();

  const alias = {};
  expect(accept({ first: alias, second: alias })).toBeNull();
  expect(accept({ value: alias }, alias)).toBeNull();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(accept(cycle)).toBeNull();
});

test("todo requires own data fields without reading inherited getters", () => {
  let reads = 0;
  const prototype = {};
  for (const key of ["id", "toolName", "name"]) {
    Object.defineProperty(prototype, key, { get() { reads += 1; return key === "id" ? 1 : "todo"; } });
  }
  const inherited = Object.create(prototype) as Record<string, unknown>;
  inherited.status = "pending";
  expect(new TodoProgressAdapter().accept(
    { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [inherited] } },
    tools,
    1,
    1,
  )).toBeNull();
  const originalToolName = Object.getOwnPropertyDescriptor(Object.prototype, "toolName");
  Object.defineProperty(Object.prototype, "toolName", { configurable: true, get() { reads += 1; return "todo"; } });
  try {
    // Missing own fields must not fall through to polluted Object.prototype.
    expect(new TodoProgressAdapter().accept(
      { isError: false, details: { action: "list", params: {}, nextId: 1, tasks: [] } },
      tools,
      1,
      1,
    )).toBeNull();
  } finally {
    if (originalToolName) Object.defineProperty(Object.prototype, "toolName", originalToolName);
    else delete (Object.prototype as Record<string, unknown>).toolName;
  }
  expect(new TodoProgressAdapter().accept(
    { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 1, tasks: [] } },
    [Object.create(prototype)],
    1,
    1,
  )).toBeNull();
  expect(reads).toBe(0);
});

test("todo rejects noncanonical arrays and accessors without reading ignored task fields", () => {
  const sparse = new Array(1);
  expect(accept({ values: sparse })).toBeNull();
  const extra: unknown[] = [];
  (extra as unknown as Record<string, unknown>).extra = null;
  expect(accept({ values: extra })).toBeNull();
  let accessorReads = 0;
  const accessor: unknown[] = [null];
  Object.defineProperty(accessor, "0", { configurable: true, get() { accessorReads += 1; return null; } });
  expect(accept({ values: accessor })).toBeNull();
  expect(accessorReads).toBe(0);

  let ignoredReads = 0;
  const task = { id: 1, status: "pending" } as Record<string, unknown>;
  Object.defineProperty(task, "subject", { enumerable: true, get() { ignoredReads += 1; return "secret"; } });
  const result = new TodoProgressAdapter().accept(
    { toolName: "todo", isError: false, details: { action: "list", params: {}, nextId: 2, tasks: [task] } },
    tools,
    1,
    1,
  );
  expect(result).toBeNull();
  expect(ignoredReads).toBe(0);
});

test("usage remains aggregate only", () => {
  const usage = new UsageTracker();
  usage.add({ input: 3, output: 2, cost: { total: 0.1 } });
  usage.setContext({ percent: 50 });
  expect(usage.snapshot()).toEqual({ tokens: 5, cost: 0.1, contextPercent: 50 });
});

test("usage prefers total tokens and bounds cost and context", () => {
  const usage = new UsageTracker();
  usage.add({ totalTokens: 0, input: 9, output: 8, cost: 2 });
  expect(usage.snapshot()).toEqual({ cost: 2 });
  usage.add({ totalTokens: 7, input: 9, output: 8, cost: { total: 3 } });
  usage.add({ totalTokens: 1_000_000, cost: 1_000_000 });
  usage.add({ totalTokens: 1, cost: 1 });
  usage.setContext({ percent: 101 });
  usage.setContext({ contextPercent: 42 });
  usage.setContext({ percent: -1 });
  expect(usage.snapshot()).toEqual({ tokens: 1_000_000, cost: 1_000_000, contextPercent: 42 });
});
