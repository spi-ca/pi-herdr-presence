import { types } from "node:util";
import type { PresenceStateInputV2 } from "@pi/presence";
import { isPlainObject } from "./validation.js";

const MAX_TASKS = 256;
const MAX_FIELDS = 32;
/** Conservative shared limit for untrusted params/error traversal, including scalars. */
const MAX_TREE_VALUES = 1_024;
const STATUSES = new Set(["pending", "in_progress", "completed", "deleted"]);
const DETAIL_KEYS = new Set(["action", "params", "tasks", "nextId", "error"]);
const TASK_KEYS = new Set([
	"id",
	"status",
	"content",
	"subject",
	"title",
	"description",
	"activeForm",
	"priority",
	"tags",
	"metadata",
	"createdAt",
	"updatedAt",
	"completedAt",
	"dueDate",
	"dependsOn",
	"blockedBy",
	"owner",
]);
const MISSING = Symbol("missing");

/** Read only an own data descriptor; inherited fields and accessors are invalid. */
function ownValue(value: Record<string, unknown>, key: string): unknown | typeof MISSING {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	return descriptor && "value" in descriptor ? descriptor.value : MISSING;
}

function ownData(
	value: Record<string, unknown>,
	keys: Iterable<PropertyKey>,
	limit = MAX_FIELDS,
): boolean {
	if (types.isProxy(value)) return false;
	const allowed = new Set(keys);
	const names = Reflect.ownKeys(value);
	if (names.length > limit) return false;
	for (const key of names) {
		if (typeof key !== "string" || !allowed.has(key) || ownValue(value, key) === MISSING)
			return false;
	}
	return true;
}
type TreeTraversal = { visited: number; identities: WeakSet<object> };

/** Extract only ordinary, dense arrays without invoking untrusted methods. */
function canonicalArray(value: unknown, maxLength: number): unknown[] | null {
	if (
		types.isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		return null;
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
	if (
		!lengthDescriptor ||
		!("value" in lengthDescriptor) ||
		!Number.isSafeInteger(lengthDescriptor.value) ||
		lengthDescriptor.value < 0 ||
		lengthDescriptor.value > maxLength
	)
		return null;
	const length = lengthDescriptor.value;
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1) return null;
	const values = new Array<unknown>(length);
	let hasLength = false;
	for (let index = 0; index < keys.length; index += 1) {
		const key = keys[index]!;
		if (key === "length") {
			if (hasLength) return null;
			hasLength = true;
			continue;
		}
		if (key !== String(index)) return null;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return null;
		values[index] = descriptor.value;
	}
	return hasLength ? values : null;
}

/**
 * Validate params and error as one bounded tree. Repeated container identities
 * are rejected rather than revisited, so aliases and cycles fail closed.
 */
function safeTree(
	value: unknown,
	traversal: TreeTraversal,
	depth = 0,
): boolean {
	if (++traversal.visited > MAX_TREE_VALUES) return false;
	if (
		value === null ||
		typeof value === "string" ||
		typeof value === "boolean"
	)
		return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (depth >= 4) return false;
	if (typeof value !== "object" || value === null || types.isProxy(value))
		return false;
	if (traversal.identities.has(value)) return false;
	traversal.identities.add(value);
	if (Array.isArray(value)) {
		const values = canonicalArray(value, MAX_TASKS);
		if (!values) return false;
		for (let index = 0; index < values.length; index += 1) {
			if (!safeTree(values[index], traversal, depth + 1)) return false;
		}
		return true;
	}
	if (!isPlainObject(value) || Reflect.ownKeys(value).length > MAX_FIELDS)
		return false;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return false;
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (
			!descriptor ||
			!("value" in descriptor) ||
			!safeTree(descriptor.value, traversal, depth + 1)
		)
			return false;
	}
	return true;
}
function owner(tools: unknown): string | null {
	const entries = canonicalArray(tools, MAX_TASKS);
	if (!entries) return null;
	let owner: string | null = null;
	for (const tool of entries) {
		if (types.isProxy(tool) || !isPlainObject(tool)) return null;
		const name = ownValue(tool, "name");
		if (name !== "todo") continue;
		const info = ownValue(tool, "sourceInfo");
		if (types.isProxy(info) || !isPlainObject(info)) return null;
		const path = ownValue(info, "path");
		const source = ownValue(info, "source");
		const scope = ownValue(info, "scope");
		const origin = ownValue(info, "origin");
		if (
			typeof path !== "string" ||
			typeof source !== "string" ||
			typeof scope !== "string" ||
			typeof origin !== "string" ||
			owner !== null
		)
			return null;
		owner = `${path}\u0000${source}\u0000${scope}\u0000${origin}`;
	}
	return owner;
}

/** Candidate local producer input. It retains counts only and never reads task text. */
export class TodoProgressAdapter {
	private owner: string | null = null;
	/** A root-session boundary permits the next session's distinct Todo implementation. */
	reset(): void {
		this.owner = null;
	}
	accept(
		event: unknown,
		tools: unknown,
		generation: number,
		sequence: number,
	): PresenceStateInputV2 | null {
		try {
			if (types.isProxy(event) || !isPlainObject(event)) return null;
			const toolName = ownValue(event, "toolName");
			const isError = ownValue(event, "isError");
			const details = ownValue(event, "details");
			if (toolName !== "todo" || isError !== false || details === MISSING) return null;
			const currentOwner = owner(tools);
			if (!currentOwner || (this.owner !== null && currentOwner !== this.owner))
				return null;
			const traversal: TreeTraversal = {
				visited: 0,
				identities: new WeakSet(),
			};
			if (
				types.isProxy(details) ||
				!isPlainObject(details) ||
				!ownData(details, DETAIL_KEYS, 5)
			)
				return null;
			const action = ownValue(details, "action");
			const params = ownValue(details, "params");
			const rawTasks = ownValue(details, "tasks");
			const nextId = ownValue(details, "nextId");
			const error = ownValue(details, "error");
			if (
				typeof action !== "string" ||
				action.length > 64 ||
				types.isProxy(params) ||
				!isPlainObject(params) ||
				rawTasks === MISSING ||
				nextId === MISSING
			)
				return null;
			const tasks = canonicalArray(rawTasks, MAX_TASKS);
			if (
				!safeTree(params, traversal) ||
				!tasks ||
				typeof nextId !== "number" ||
				!Number.isSafeInteger(nextId) ||
				nextId < 1 ||
				nextId > Number.MAX_SAFE_INTEGER ||
				(error !== MISSING && error !== undefined && !safeTree(error, traversal))
			)
				return null;
			let active = 0;
			let completed = 0;
			let visible = 0;
			const taskIds = new Set<number>();
			for (let index = 0; index < tasks.length; index += 1) {
				const rawTask = tasks[index];
				if (
					types.isProxy(rawTask) ||
					!isPlainObject(rawTask) ||
					!ownData(rawTask, TASK_KEYS)
				)
					return null;
				const id = ownValue(rawTask, "id");
				const status = ownValue(rawTask, "status");
				if (
					typeof id !== "number" ||
					!Number.isSafeInteger(id) ||
					id < 1 ||
					id > Number.MAX_SAFE_INTEGER ||
					typeof status !== "string" ||
					!STATUSES.has(status)
				)
					return null;
				if (taskIds.has(id)) return null;
				taskIds.add(id);
				if (status === "deleted") continue;
				visible += 1;
				if (status === "in_progress") active += 1;
				else if (status === "completed") completed += 1;
			}

			this.owner = currentOwner;
			const result: PresenceStateInputV2 = {
				version: 2,
				generation,
				sequence,
				source: "todo",
				state:
					active > 0
						? "running"
						: visible === 0
							? "idle"
							: completed === visible
								? "success"
								: "waiting",
			};
			if (visible === 0) return result;
			return { ...result, progress: { completed, total: visible } };
		} catch {
			return null;
		}
	}
}
