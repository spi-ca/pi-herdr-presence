import type { NotificationPolicy } from "./notification-policy.js";

/** An active mode is selected only after the managed-hook probe proves its prerequisite. */
export type PresenceMode = "standalone" | "companion" | "disabled";
type PresenceModeSetting = PresenceMode | "auto";

export interface PresenceConfig {
	enabled: boolean;
	/** Deprecated compatibility acknowledgement; automatic standalone no longer needs it. */
	soleReporter: boolean;
	/** `auto` selects from the exact managed-hook result; explicit values can only restrict it. */
	mode: PresenceModeSetting;
	timeoutMs: number;
	maxQueue: number;
	notifications: boolean;
	notificationPolicy: NotificationPolicy;
	metadata: boolean;
	finalClearMs: number;
	maxLabelChars: number;
	longRunningMs: number;
}
type BooleanSetting = { type: "boolean"; env: string; defaultValue: boolean };
type IntegerSetting = {
	type: "integer";
	env: string;
	defaultValue: number;
	min: number;
	max: number;
};
type EnumSetting<T extends string> = {
	type: "enum";
	env: string;
	defaultValue: T;
	values: readonly T[];
};
type Setting = BooleanSetting | IntegerSetting | EnumSetting<string>;
const SETTINGS = {
	enabled: {
		type: "boolean",
		env: "PI_HERDR_PRESENCE_ENABLED",
		defaultValue: true,
	},
	soleReporter: {
		type: "boolean",
		env: "PI_HERDR_PRESENCE_SOLE_REPORTER",
		defaultValue: false,
	},
	mode: {
		type: "enum",
		env: "PI_HERDR_PRESENCE_MODE",
		defaultValue: "auto",
		values: ["auto", "standalone", "companion", "disabled"],
	},
	timeoutMs: {
		type: "integer",
		env: "PI_HERDR_PRESENCE_TIMEOUT_MS",
		defaultValue: 1_000,
		min: 100,
		max: 30_000,
	},
	maxQueue: {
		type: "integer",
		env: "PI_HERDR_PRESENCE_MAX_QUEUE",
		defaultValue: 16,
		min: 1,
		max: 128,
	},
	notifications: {
		type: "boolean",
		env: "PI_HERDR_PRESENCE_NOTIFICATIONS",
		defaultValue: true,
	},
	notificationPolicy: {
		type: "enum",
		env: "PI_HERDR_PRESENCE_NOTIFY_POLICY",
		defaultValue: "errors",
		values: ["errors", "background", "settled", "all", "disabled"],
	},
	metadata: {
		type: "boolean",
		env: "PI_HERDR_PRESENCE_METADATA",
		defaultValue: true,
	},
	finalClearMs: {
		type: "integer",
		env: "PI_HERDR_PRESENCE_FINAL_CLEAR_MS",
		defaultValue: 1_500,
		min: 0,
		max: 60_000,
	},
	maxLabelChars: {
		type: "integer",
		env: "PI_HERDR_PRESENCE_MAX_LABEL_CHARS",
		defaultValue: 96,
		min: 16,
		max: 256,
	},
	longRunningMs: {
		type: "integer",
		env: "PI_HERDR_PRESENCE_LONG_RUNNING_MS",
		defaultValue: 30_000,
		min: 1_000,
		max: 300_000,
	},
} as const satisfies Record<keyof PresenceConfig, Setting>;
function bool(env: NodeJS.ProcessEnv, setting: BooleanSetting): boolean {
	const value = env[setting.env]?.trim().toLowerCase();
	if (value === undefined || value === "") return setting.defaultValue;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	if (["0", "false", "no", "off"].includes(value)) return false;
	return setting.defaultValue;
}

function integer(env: NodeJS.ProcessEnv, setting: IntegerSetting): number {
	const value = env[setting.env]?.trim();
	if (!value || !/^\d+$/.test(value)) return setting.defaultValue;

	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) return setting.defaultValue;
	if (parsed < setting.min || parsed > setting.max) return setting.defaultValue;
	return parsed;
}

function enumeration<T extends string>(
	env: NodeJS.ProcessEnv,
	setting: EnumSetting<T>,
): T {
	const value = env[setting.env]?.trim().toLowerCase();
	if (value === undefined || !setting.values.includes(value as T)) {
		return setting.defaultValue;
	}
	return value as T;
}
export function resolvePresenceConfig(
	env: NodeJS.ProcessEnv = process.env,
): PresenceConfig {
	return {
		enabled: bool(env, SETTINGS.enabled),
		soleReporter: bool(env, SETTINGS.soleReporter),
		mode: enumeration(env, SETTINGS.mode),
		timeoutMs: integer(env, SETTINGS.timeoutMs),
		maxQueue: integer(env, SETTINGS.maxQueue),
		notifications: bool(env, SETTINGS.notifications),
		notificationPolicy: enumeration(env, SETTINGS.notificationPolicy),
		metadata: bool(env, SETTINGS.metadata),
		finalClearMs: integer(env, SETTINGS.finalClearMs),
		maxLabelChars: integer(env, SETTINGS.maxLabelChars),
		longRunningMs: integer(env, SETTINGS.longRunningMs),
	};
}

/** Explicit mode selection never upgrades an ambiguous managed-hook probe. */
export function resolvePresenceMode(
	config: PresenceConfig,
	official: "present" | "absent" | "unknown",
): PresenceMode {
	if (!config.enabled || config.mode === "disabled" || official === "unknown")
		return "disabled";
	const automatic: PresenceMode =
		official === "present" ? "companion" : "standalone";
	return config.mode === "auto" || config.mode === automatic
		? automatic
		: "disabled";
}
