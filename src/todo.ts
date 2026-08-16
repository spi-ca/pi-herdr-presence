import type { PresenceUpdate } from "./events.js";
import { isPlainObject } from "./validation.js";

const MAX_TASKS = 256;
const MAX_FIELDS = 32;
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const DETAIL_KEYS = new Set(["action", "params", "tasks", "nextId", "error"]);
// RPIV task descriptions are intentionally never read or retained.
const TASK_KEYS = new Set(["id", "status", "content", "subject", "title", "description", "activeForm", "priority", "tags", "metadata", "createdAt", "updatedAt", "completedAt", "dueDate", "dependsOn", "blockedBy", "owner"]);

type ToolInfoLike = { name?: unknown; sourceInfo?: { path?: unknown; source?: unknown; scope?: unknown; origin?: unknown } };

function ownData(value: Record<string, unknown>, keys: Iterable<PropertyKey>, limit = MAX_FIELDS): boolean {
  const allowed = new Set(keys);
  const names = Reflect.ownKeys(value);
  if (names.length > limit) return false;
  for (const key of names) {
    if (typeof key !== "string" || !allowed.has(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  return true;
}
function safeTree(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (depth >= 4) return false;
  if (Array.isArray(value)) return value.length <= MAX_TASKS && value.every((item) => safeTree(item, depth + 1));
  if (!isPlainObject(value) || Reflect.ownKeys(value).length > MAX_FIELDS) return false;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !safeTree(descriptor.value, depth + 1)) return false;
  }
  return true;
}
function owner(tools: unknown): string | null {
  if (!Array.isArray(tools)) return null;
  const matches = tools.filter((tool): tool is ToolInfoLike => isPlainObject(tool) && tool.name === "todo");
  if (matches.length !== 1) return null;
  const info = matches[0].sourceInfo;
  if (!isPlainObject(info) || typeof info.path !== "string" || typeof info.source !== "string" || typeof info.scope !== "string" || typeof info.origin !== "string") return null;
  return `${info.path}\u0000${info.source}\u0000${info.scope}\u0000${info.origin}`;
}

/** Parse the installed RPIV TaskDetails envelope without ever copying task text. */
export class TodoProgressAdapter {
  private owner: string | null = null;
  accept(event: unknown, tools: unknown, sessionId: string, generation: number, sequence: number): PresenceUpdate | null {
    try {
      if (!isPlainObject(event) || event.toolName !== "todo" || event.isError !== false) return null;
      const currentOwner = owner(tools);
      if (!currentOwner || (this.owner !== null && currentOwner !== this.owner)) return null;
      const details = event.details;
      if (!isPlainObject(details) || !ownData(details, DETAIL_KEYS, 5) || typeof details.action !== "string" || details.action.length > 64 || !isPlainObject(details.params) || !safeTree(details.params) || !Array.isArray(details.tasks) || details.tasks.length > MAX_TASKS || !Number.isSafeInteger(details.nextId) || (details.nextId as number) < 1 || (details.nextId as number) > Number.MAX_SAFE_INTEGER || (details.error !== undefined && !safeTree(details.error))) return null;
      let active = 0; let completed = 0; let queued = 0; let visible = 0;
      const taskIds = new Set<number>();
      for (const rawTask of details.tasks) {
        if (!isPlainObject(rawTask) || !ownData(rawTask, TASK_KEYS) || !Number.isSafeInteger(rawTask.id) || (rawTask.id as number) < 1 || (rawTask.id as number) > Number.MAX_SAFE_INTEGER || typeof rawTask.status !== "string" || !STATUSES.has(rawTask.status)) return null;
        const id = rawTask.id as number; const status = rawTask.status;
        if (taskIds.has(id)) return null;
        taskIds.add(id);
        if (status === "deleted") continue;
        visible += 1;
        if (status === "in_progress") active += 1;
        else if (status === "completed") completed += 1;
        else queued += 1;
      }
      this.owner = currentOwner;
      return {
        version: 1, sessionId, generation, sequence,
        source: { id: "pi-todo", label: "Pi todo", kind: "todo" },
        state: active > 0 ? "running" : visible === 0 ? "idle" : completed === visible ? "success" : "waiting",
        counts: { active, completed, failed: 0, queued, cancelled: 0, total: visible },
        ...(visible > 0 ? { progress: { value: completed / visible } } : {}),
      };
    } catch { return null; }
  }
}
