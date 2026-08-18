import type { PresenceStateInputV2 } from "@pi/presence";
import { isPlainObject } from "./validation.js";

const MAX_TASKS = 256;
const MAX_FIELDS = 32;
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const DETAIL_KEYS = new Set(["action", "params", "tasks", "nextId", "error"]);
const TASK_KEYS = new Set(["id", "status", "content", "subject", "title", "description", "activeForm", "priority", "tags", "metadata", "createdAt", "updatedAt", "completedAt", "dueDate", "dependsOn", "blockedBy", "owner"]);
type ToolInfoLike = { name?: unknown; sourceInfo?: { path?: unknown; source?: unknown; scope?: unknown; origin?: unknown } };

function ownData(value: Record<string, unknown>, keys: Iterable<PropertyKey>, limit = MAX_FIELDS): boolean { const allowed = new Set(keys); const names = Reflect.ownKeys(value); return names.length <= limit && names.every(key => typeof key === "string" && allowed.has(key) && !!Object.getOwnPropertyDescriptor(value, key) && "value" in Object.getOwnPropertyDescriptor(value, key)!); }
function safeTree(value: unknown, depth = 0): boolean { if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (depth >= 4 || Array.isArray(value) && value.length > MAX_TASKS || !Array.isArray(value) && !isPlainObject(value)) return false; return Array.isArray(value) ? value.every(item => safeTree(item, depth + 1)) : Reflect.ownKeys(value).length <= MAX_FIELDS && Reflect.ownKeys(value).every(key => typeof key === "string" && !!Object.getOwnPropertyDescriptor(value, key) && "value" in Object.getOwnPropertyDescriptor(value, key)! && safeTree(Object.getOwnPropertyDescriptor(value, key)!.value, depth + 1)); }
function owner(tools: unknown): string | null { if (!Array.isArray(tools)) return null; const matches = tools.filter((tool): tool is ToolInfoLike => isPlainObject(tool) && tool.name === "todo"); if (matches.length !== 1) return null; const info = matches[0].sourceInfo; return isPlainObject(info) && typeof info.path === "string" && typeof info.source === "string" && typeof info.scope === "string" && typeof info.origin === "string" ? `${info.path}\u0000${info.source}\u0000${info.scope}\u0000${info.origin}` : null; }

/** Candidate local producer input. It retains counts only and never reads task text. */
export class TodoProgressAdapter {
  private owner: string | null = null;
  /** A root-session boundary permits the next session's distinct Todo implementation. */
  reset(): void { this.owner = null; }
  accept(event: unknown, tools: unknown, generation: number, sequence: number): PresenceStateInputV2 | null {
    try {
      if (!isPlainObject(event) || event.toolName !== "todo" || event.isError !== false) return null;
      const currentOwner = owner(tools); if (!currentOwner || this.owner !== null && currentOwner !== this.owner) return null;
      const details = event.details;
      if (!isPlainObject(details) || !ownData(details, DETAIL_KEYS, 5) || typeof details.action !== "string" || details.action.length > 64 || !isPlainObject(details.params) || !safeTree(details.params) || !Array.isArray(details.tasks) || details.tasks.length > MAX_TASKS || !Number.isSafeInteger(details.nextId) || (details.nextId as number) < 1 || (details.nextId as number) > Number.MAX_SAFE_INTEGER || details.error !== undefined && !safeTree(details.error)) return null;
      let active = 0; let completed = 0; let visible = 0; const taskIds = new Set<number>();
      for (const rawTask of details.tasks) {
        if (!isPlainObject(rawTask) || !ownData(rawTask, TASK_KEYS) || !Number.isSafeInteger(rawTask.id) || (rawTask.id as number) < 1 || typeof rawTask.status !== "string" || !STATUSES.has(rawTask.status) || taskIds.has(rawTask.id as number)) return null;
        taskIds.add(rawTask.id as number); if (rawTask.status === "deleted") continue; visible += 1;
        if (rawTask.status === "in_progress") active += 1; else if (rawTask.status === "completed") completed += 1;
      }
      this.owner = currentOwner;
      return { version: 2, generation, sequence, source: "todo", state: active > 0 ? "running" : visible === 0 ? "idle" : completed === visible ? "success" : "waiting", ...(visible > 0 ? { progress: { completed, total: visible } } : {}) };
    } catch { return null; }
  }
}
