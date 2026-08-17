import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PresenceConfig } from "./config.js";
import { readHerdrIdentity, safeSocketFingerprint } from "./identity.js";
import { officialHookStatus, type OfficialHookStatus } from "./official-hook.js";
import { decodeHerdrResponse, encodeHerdrRequest } from "./protocol.js";
import { HerdrSocketTransport } from "./transport.js";
import { hasControlOrBidi, isPlainObject } from "./validation.js";

export interface PresenceDoctorReport {
  enabled: boolean;
  environment: { herdrEnv: boolean; paneConfigured: boolean; socketConfigured: boolean; identity: "configured" | "incomplete" };
  managedIntegration: OfficialHookStatus;
  socket: "not-configured" | "not-run" | "safe" | "unsafe";
  ping: "not-run" | "ok" | "failed";
  paneBinding: "not-run" | "bound" | "unverified" | "failed";
  ready: boolean;
}

const configured = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const ownData = (value: unknown, keys: readonly string[]): Record<string, unknown> | null => {
  if (!isPlainObject(value) || !Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.includes(key)) || !keys.every((key) => Object.hasOwn(value, key))) return null;
  const snapshot: Record<string, unknown> = {};
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor || !("value" in descriptor)) return null; snapshot[key] = descriptor.value; }
  return snapshot;
};
const boundedId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 256 && !hasControlOrBidi(value);
/** The exact tagged pong arm supported by Herdr protocol 19 and 20. */
function isSupportedPong(value: unknown): boolean { const pong = ownData(value, ["type", "protocol"]); return pong?.type === "pong" && (pong.protocol === 19 || pong.protocol === 20); }
/** Only the canonical pane.get tagged arm binds this configured pane. */
function boundToPane(value: unknown, paneId: string): boolean {
  const result = ownData(value, ["type", "pane"]);
  if (!result || result.type !== "pane_info" || !isPlainObject(result.pane)) return false;
  const keys = Reflect.ownKeys(result.pane);
  // The authoritative pane is an object, but only its bounded own data pane_id
  // is consumed. Bound the shape so an untrusted reply cannot be arbitrarily large.
  if (keys.length < 1 || keys.length > 32 || !keys.every((key) => typeof key === "string")) return false;
  const field = (name: string): unknown => { const descriptor = Object.getOwnPropertyDescriptor(result.pane, name); return descriptor && "value" in descriptor ? descriptor.value : undefined; };
  // Herdr's canonical PaneInfo identity is four opaque public IDs. Even though
  // this observer only binds pane_id, validate all of them before trusting it.
  return boundedId(field("workspace_id")) && boundedId(field("tab_id")) && boundedId(field("pane_id")) && boundedId(field("terminal_id")) && field("pane_id") === paneId;
}

/** Performs exactly two allowlisted, read-only requests; no fallback discovery. */
export async function runPresenceDoctor(env: NodeJS.ProcessEnv = process.env, config: Pick<PresenceConfig, "enabled" | "timeoutMs" | "maxQueue">): Promise<PresenceDoctorReport> {
  const identity = readHerdrIdentity(env);
  const managedIntegration = await officialHookStatus(env);
  const report: PresenceDoctorReport = {
    enabled: config.enabled,
    environment: { herdrEnv: env.HERDR_ENV === "1", paneConfigured: configured(env.HERDR_PANE_ID), socketConfigured: configured(env.HERDR_SOCKET_PATH), identity: identity ? "configured" : "incomplete" },
    managedIntegration, socket: !config.enabled ? "not-run" : !identity ? "not-configured" : managedIntegration === "absent" ? "unsafe" : "not-run", ping: "not-run", paneBinding: "not-run", ready: false,
  };
  // Disabled, managed, or ambiguous authority deliberately prevents every
  // socket probe; that is not evidence that the configured socket is unsafe.
  if (!config.enabled || !identity || managedIntegration !== "absent") return report;
  try { await safeSocketFingerprint(identity.socketPath); report.socket = "safe"; } catch { return report; }
  const transport = new HerdrSocketTransport(identity.socketPath, config.timeoutMs, config.maxQueue);
  try {
    const pingId = "herdr:pi:doctor:ping";
    const pong = decodeHerdrResponse(await transport.request(encodeHerdrRequest({ id: pingId, method: "ping", params: {} }), "doctor-ping", true), pingId);
    if (!isSupportedPong(pong)) throw new Error("Unsupported Herdr ping response.");
    report.ping = "ok";
  } catch { report.ping = "failed"; await transport.close(config.timeoutMs).catch(() => {}); return report; }
  try {
    const paneId = "herdr:pi:doctor:pane";
    const result = decodeHerdrResponse(await transport.request(encodeHerdrRequest({ id: paneId, method: "pane.get", params: { pane_id: identity.paneId } }), "doctor-pane", true), paneId);
    report.paneBinding = boundToPane(result, identity.paneId) ? "bound" : "unverified";
  } catch { report.paneBinding = "failed"; }
  await transport.close(config.timeoutMs).catch(() => {});
  report.ready = report.socket === "safe" && report.ping === "ok" && report.paneBinding === "bound";
  return report;
}

export function formatPresenceDoctorReport(report: PresenceDoctorReport): string {
  const env = report.environment;
  return `Herdr presence: ${!report.enabled ? "disabled (not ready)" : report.ready ? "ready" : "not ready"}\nenabled: ${report.enabled}; HERDR_ENV: ${env.herdrEnv}; HERDR_PANE_ID configured: ${env.paneConfigured}; HERDR_SOCKET_PATH configured: ${env.socketConfigured}\nidentity: ${env.identity}; managed integration: ${report.managedIntegration}\nsocket safety: ${report.socket}; ping: ${report.ping}; pane binding: ${report.paneBinding}`;
}

export function registerPresenceDoctor(pi: ExtensionAPI, config: Pick<PresenceConfig, "enabled" | "timeoutMs" | "maxQueue">): void {
  const register = (pi as ExtensionAPI & { registerCommand?: ExtensionAPI["registerCommand"] }).registerCommand;
  if (typeof register !== "function") return;
  register.call(pi, "herdr-presence-doctor", {
    description: "Herdr presence read-only readiness diagnosis",
    handler: async (_args, context) => { context.ui.notify(formatPresenceDoctorReport(await runPresenceDoctor(process.env, config)), "info"); },
  });
}
