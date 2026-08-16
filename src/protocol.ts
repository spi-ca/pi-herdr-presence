import { CMUX_UUID_RE } from "./identity.js";
import { hasControlOrBidi, isPlainObject, isProtocolToken } from "./validation.js";

export class PresenceProtocolError extends Error {}

export const CMUX_TEXT_BYTES = {
  v1Text: 512,
  notificationTitle: 128,
  notificationBody: 512,
  autoTitle: 128,
  resumeCommand: 512,
} as const;

export type V2Method =
  | "system.capabilities"
  | "notification.create_for_surface"
  | "surface.trigger_flash"
  | "feed.push"
  | "surface.resume.get"
  | "surface.resume.set"
  | "surface.resume.clear"
  | "workspace.set_auto_title";

export interface V2Request {
  id: number;
  method: V2Method;
  params: Record<string, unknown>;
}


function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Reflect.ownKeys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function optionalKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key))
    && required.every((key) => Object.hasOwn(value, key));
}

function text(value: unknown, maxBytes: number = CMUX_TEXT_BYTES.v1Text): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !hasControlOrBidi(value);
}

function target(workspace: unknown, surface: unknown): boolean {
  return typeof workspace === "string"
    && CMUX_UUID_RE.test(workspace)
    && typeof surface === "string"
    && CMUX_UUID_RE.test(surface);
}

function checkpoint(value: unknown): value is string {
  return isProtocolToken(value);
}

/** Validate each RPC shape before serializing it; no generic free-form params cross the socket. */
function validV2(request: V2Request): boolean {
  const params = request.params;

  switch (request.method) {
    case "system.capabilities":
      return keys(params, []);
    case "surface.trigger_flash":
      return keys(params, ["workspace_id", "surface_id"])
        && target(params.workspace_id, params.surface_id);
    case "notification.create_for_surface":
      return keys(params, ["workspace_id", "surface_id", "title", "body"])
        && target(params.workspace_id, params.surface_id)
        && text(params.title, CMUX_TEXT_BYTES.notificationTitle)
        && text(params.body, CMUX_TEXT_BYTES.notificationBody);
    case "workspace.set_auto_title":
      return keys(params, ["workspace_id", "title"])
        && typeof params.workspace_id === "string"
        && CMUX_UUID_RE.test(params.workspace_id)
        && text(params.title, CMUX_TEXT_BYTES.autoTitle);
    case "feed.push": {
      if (!keys(params, ["workspace_id", "surface_id", "event"])
        || !target(params.workspace_id, params.surface_id)
        || !isPlainObject(params.event)) {
        return false;
      }

      const event = params.event;
      const required = ["session_id", "hook_event_name", "_source", "workspace_id", "surface_id"];
      if (!optionalKeys(event, [...required, "tool_call_id", "tool_name"], required)
        || !target(event.workspace_id, event.surface_id)
        || event.workspace_id !== params.workspace_id
        || event.surface_id !== params.surface_id
        || !checkpoint(event.session_id)
        || event._source !== "pi"
        || typeof event.hook_event_name !== "string"
        || !["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"].includes(event.hook_event_name)) {
        return false;
      }

      const isToolEvent = event.hook_event_name === "PreToolUse" || event.hook_event_name === "PostToolUse";
      if (!isToolEvent) return event.tool_call_id === undefined && event.tool_name === undefined;

      return (event.tool_call_id === undefined || checkpoint(event.tool_call_id))
        && (event.tool_name === undefined || text(event.tool_name, CMUX_TEXT_BYTES.notificationTitle));
    }
    case "surface.resume.get":
      return keys(params, ["workspace_id", "surface_id"])
        && target(params.workspace_id, params.surface_id);
    case "surface.resume.set":
      return keys(params, ["workspace_id", "surface_id", "name", "checkpoint_id", "kind", "source", "environment", "command", "auto_resume"])
        && target(params.workspace_id, params.surface_id)
        && params.name === "Pi"
        && checkpoint(params.checkpoint_id)
        && params.kind === "pi"
        && params.source === "agent-hook"
        && isPlainObject(params.environment)
        && keys(params.environment, [])
        && text(params.command, CMUX_TEXT_BYTES.resumeCommand)
        && params.auto_resume === true;
    case "surface.resume.clear":
      return keys(params, ["workspace_id", "surface_id", "checkpoint_id", "source"])
        && target(params.workspace_id, params.surface_id)
        && checkpoint(params.checkpoint_id)
        && params.source === "agent-hook";
  }
}

export function encodeV2(request: V2Request): string {
  if (!Number.isSafeInteger(request.id) || request.id < 1 || !isPlainObject(request.params) || !validV2(request)) {
    throw new PresenceProtocolError("Invalid V2 request.");
  }

  const line = JSON.stringify(request);
  if (Buffer.byteLength(line, "utf8") > 16 * 1024 || line.includes("\r") || line.includes("\n")) {
    throw new PresenceProtocolError("V2 request exceeds its bound.");
  }
  return `${line}\n`;
}

export function decodeV2Response(line: string, id: number): unknown {
  if (!line || line.includes("\r") || Buffer.byteLength(line, "utf8") > 16 * 1024) {
    throw new PresenceProtocolError("Invalid V2 response line.");
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new PresenceProtocolError("Invalid V2 JSON response.");
  }

  if (!isPlainObject(value) || value.id !== id || typeof value.ok !== "boolean") {
    throw new PresenceProtocolError("Invalid V2 response envelope.");
  }
  if (value.ok === true && keys(value, ["id", "ok", "result"])) return value.result;
  if (value.ok === false
    && keys(value, ["id", "ok", "error"])
    && isPlainObject(value.error)
    && optionalKeys(value.error, ["code", "message"], ["code", "message"])
    && (typeof value.error.code === "string" || typeof value.error.code === "number")
    && typeof value.error.message === "string") {
    throw new PresenceProtocolError("V2 remote error.");
  }
  throw new PresenceProtocolError("Invalid V2 response envelope.");
}

function v1Part(value: string): string {
  if (!text(value, CMUX_TEXT_BYTES.v1Text)) {
    throw new PresenceProtocolError("Invalid V1 text field.");
  }
  return JSON.stringify(value);
}

function v1Token(value: string): string {
  if (!isProtocolToken(value)) throw new PresenceProtocolError("Invalid V1 token.");
  return value;
}

function v1Pid(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new PresenceProtocolError("Invalid V1 PID.");
  }
  return value;
}

function v1Priority(value: number): number {
  if (!Number.isSafeInteger(value) || value < -9_999 || value > 9_999) {
    throw new PresenceProtocolError("Invalid V1 priority.");
  }
  return value;
}

function v1Color(value: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(value)) throw new PresenceProtocolError("Invalid V1 color.");
  return value;
}

function rawMarkdown(value: string): string {
  const invalidControl = hasControlOrBidi(value.replace(/[\n\t]/g, ""));
  if (!value || Buffer.byteLength(value, "utf8") > 1024 || invalidControl || value.includes("\\")) {
    throw new PresenceProtocolError("Invalid V1 markdown.");
  }
  return value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
}

export type V1Command =
  | { command: "set_status"; tab: string; panel: string; key: string; label: string; icon: string; color: string; priority: number }
  | { command: "clear_status"; tab: string; key: string }
  | { command: "set_progress"; tab: string; value: number; label?: string }
  | { command: "clear_progress"; tab: string }
  | { command: "log"; tab: string; level: "info" | "success" | "warning" | "error"; message: string }
  | { command: "set_agent_pid"; tab: string; panel: string; key: "pi"; pid: number }
  | { command: "set_agent_lifecycle"; tab: string; panel: string; key: "pi"; lifecycle: "unknown" | "running" | "idle" | "needsInput" }
  // cmux has no compare-and-clear; panel is the narrowest available ownership boundary.
  | { command: "clear_agent_pid"; tab: string; panel: string; key: "pi" }
  | { command: "report_meta_block"; tab: string; key: string; markdown: string; priority: number }
  | { command: "clear_meta_block"; tab: string; key: string };

export function encodeV1(command: V1Command): string {
  const tab = v1Token(command.tab);

  switch (command.command) {
    // cmux 0.64.20: key and value are positional before all options.
    case "set_status":
      return `set_status ${v1Token(command.key)} ${v1Part(command.label)} --icon=${v1Token(command.icon)} --color=${v1Color(command.color)} --priority=${v1Priority(command.priority)} --tab=${tab} --panel=${v1Token(command.panel)}\n`;
    case "clear_status":
      return `clear_status ${v1Token(command.key)} --tab=${tab}\n`;
    case "set_progress":
      if (!Number.isFinite(command.value) || command.value < 0 || command.value > 1) {
        throw new PresenceProtocolError("Invalid V1 progress.");
      }
      return `set_progress ${command.value.toFixed(2)}${command.label === undefined ? "" : ` --label=${v1Part(command.label)}`} --tab=${tab}\n`;
    case "clear_progress":
      return `clear_progress --tab=${tab}\n`;
    case "log":
      return `log --level=${command.level} --source=pi-cmux-presence --tab=${tab} -- ${v1Part(command.message)}\n`;
    case "set_agent_pid":
      return `set_agent_pid ${command.key} ${v1Pid(command.pid)} --tab=${tab} --panel=${v1Token(command.panel)}\n`;
    case "set_agent_lifecycle":
      return `set_agent_lifecycle ${command.key} ${command.lifecycle} --tab=${tab} --panel=${v1Token(command.panel)}\n`;
    case "clear_agent_pid":
      return `clear_agent_pid ${command.key} --tab=${tab} --panel=${v1Token(command.panel)}\n`;
    case "report_meta_block":
      return `report_meta_block ${v1Token(command.key)} --priority=${v1Priority(command.priority)} --tab=${tab} -- ${rawMarkdown(command.markdown)}\n`;
    case "clear_meta_block":
      return `clear_meta_block ${v1Token(command.key)} --tab=${tab}\n`;
  }
}

export function decodeV1Response(line: string): void {
  if (line !== "OK") throw new PresenceProtocolError("Invalid V1 response.");
}
