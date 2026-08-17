import type { NotificationPolicy } from "./notification-policy.js";

export interface PresenceConfig {
  enabled: boolean;
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
type IntegerSetting = { type: "integer"; env: string; defaultValue: number; min: number; max: number };
type EnumSetting<T extends string> = { type: "enum"; env: string; defaultValue: T; values: readonly T[] };
type Setting = BooleanSetting | IntegerSetting | EnumSetting<string>;
const SETTINGS = {
  enabled: { type: "boolean", env: "PI_HERDR_PRESENCE_ENABLED", defaultValue: true },
  timeoutMs: { type: "integer", env: "PI_HERDR_PRESENCE_TIMEOUT_MS", defaultValue: 1_000, min: 100, max: 30_000 },
  maxQueue: { type: "integer", env: "PI_HERDR_PRESENCE_MAX_QUEUE", defaultValue: 16, min: 1, max: 128 },
  notifications: { type: "boolean", env: "PI_HERDR_PRESENCE_NOTIFICATIONS", defaultValue: true },
  notificationPolicy: { type: "enum", env: "PI_HERDR_PRESENCE_NOTIFY_POLICY", defaultValue: "errors", values: ["errors", "background", "settled", "all", "disabled"] },
  metadata: { type: "boolean", env: "PI_HERDR_PRESENCE_METADATA", defaultValue: true },
  finalClearMs: { type: "integer", env: "PI_HERDR_PRESENCE_FINAL_CLEAR_MS", defaultValue: 1_500, min: 0, max: 60_000 },
  maxLabelChars: { type: "integer", env: "PI_HERDR_PRESENCE_MAX_LABEL_CHARS", defaultValue: 96, min: 16, max: 256 },
  longRunningMs: { type: "integer", env: "PI_HERDR_PRESENCE_LONG_RUNNING_MS", defaultValue: 30_000, min: 1_000, max: 300_000 },
} as const satisfies Record<keyof PresenceConfig, Setting>;
function bool(env: NodeJS.ProcessEnv, setting: BooleanSetting): boolean { const v = env[setting.env]?.trim().toLowerCase(); return v === undefined || v === "" ? setting.defaultValue : ["1", "true", "yes", "on"].includes(v) ? true : ["0", "false", "no", "off"].includes(v) ? false : setting.defaultValue; }
function integer(env: NodeJS.ProcessEnv, setting: IntegerSetting): number { const v = env[setting.env]?.trim(); if (!v || !/^\d+$/.test(v)) return setting.defaultValue; const n = Number(v); return Number.isSafeInteger(n) && n >= setting.min && n <= setting.max ? n : setting.defaultValue; }
function enumeration<T extends string>(env: NodeJS.ProcessEnv, setting: EnumSetting<T>): T { const v = env[setting.env]?.trim().toLowerCase(); return v !== undefined && setting.values.includes(v as T) ? v as T : setting.defaultValue; }
export function resolvePresenceConfig(env: NodeJS.ProcessEnv = process.env): PresenceConfig { return { enabled: bool(env, SETTINGS.enabled), timeoutMs: integer(env, SETTINGS.timeoutMs), maxQueue: integer(env, SETTINGS.maxQueue), notifications: bool(env, SETTINGS.notifications), notificationPolicy: enumeration(env, SETTINGS.notificationPolicy), metadata: bool(env, SETTINGS.metadata), finalClearMs: integer(env, SETTINGS.finalClearMs), maxLabelChars: integer(env, SETTINGS.maxLabelChars), longRunningMs: integer(env, SETTINGS.longRunningMs) }; }
