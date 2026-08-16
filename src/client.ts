import { isPlainObject, isProtocolToken } from "./validation.js";
import type { PresenceConfig } from "./config.js";
import type { CmuxIdentity } from "./identity.js";
import {
  decodeV1Response,
  decodeV2Response,
  encodeV1,
  encodeV2,
  type V1Command,
  type V2Method,
} from "./protocol.js";
import { UnixSocketTransport } from "./transport.js";

const OPTIONAL_METHODS = new Set<V2Method>([
  "notification.create_for_surface",
  "surface.trigger_flash",
  "feed.push",
  "surface.resume.get",
  "surface.resume.set",
  "surface.resume.clear",
  "workspace.set_auto_title",
]);

function capabilities(value: unknown): Set<V2Method> {
  try {
    const allowed = ["protocol", "version", "methods", "access_mode", "socket_path"];
    if (!isPlainObject(value)
      || !Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.includes(key))
      || value.protocol !== "cmux-socket"
      || value.version !== 2
      || !Array.isArray(value.methods)
      || value.methods.length > 512
      || !value.methods.every((method) => isProtocolToken(method))) {
      return new Set();
    }

    return new Set(
      value.methods.filter((method): method is V2Method => OPTIONAL_METHODS.has(method as V2Method)),
    );
  } catch {
    return new Set();
  }
}

type ResumeBinding = { kind: "pi"; source: "agent-hook"; checkpoint_id: string };

function resumeBinding(value: unknown): ResumeBinding | null | undefined {
  try {
    if (!isPlainObject(value) || !Object.hasOwn(value, "resume_binding")) return undefined;
    const binding = value.resume_binding;
    if (binding === null) return null;
    if (!isPlainObject(binding)
      || binding.kind !== "pi"
      || binding.source !== "agent-hook"
      || !isProtocolToken(binding.checkpoint_id)) {
      return undefined;
    }
    return { kind: "pi", source: "agent-hook", checkpoint_id: binding.checkpoint_id };
  } catch {
    return undefined;
  }
}

export class PresenceClient {
  private nextId = 1;
  private supported = new Set<V2Method>();
  private closed = false;
  private closeOperation: Promise<void> | null = null;
  private ownsResumeFallback = false;
  private resumeInstallOperation: Promise<void> | null = null;

  constructor(
    private readonly identity: CmuxIdentity,
    private readonly transport: UnixSocketTransport,
    private readonly config: PresenceConfig,
  ) {}

  async initialize(): Promise<void> {
    const id = this.nextId++;
    try {
      const response = await this.transport.request(
        encodeV2({ id, method: "system.capabilities", params: {} }),
      );
      this.supported = capabilities(decodeV2Response(response, id));
    } catch {
      this.supported.clear();
    }
  }

  async initializeOwnedProgress(): Promise<void> {
    // Run only after the runtime has made this client the current session owner.
    if (this.config.progress) {
      await this.v1({ command: "clear_progress", tab: this.identity.workspaceId }, "progress");
    }
  }

  async status(
    key: string,
    label: string,
    style: { icon: string; color: string; priority: number },
  ): Promise<void> {
    if (!this.config.sidebar) return;
    await this.v1({
      command: "set_status",
      tab: this.identity.workspaceId,
      panel: this.identity.surfaceId,
      key,
      label,
      ...style,
    }, `status:${key}`);
  }

  async clearStatus(key: string): Promise<void> {
    if (!this.config.sidebar) return;
    await this.v1({ command: "clear_status", tab: this.identity.workspaceId, key }, `status:${key}`);
  }

  async progress(value: number, label?: string): Promise<void> {
    if (!this.config.progress) return;
    await this.v1({ command: "set_progress", tab: this.identity.workspaceId, value, label }, "progress");
  }

  async clearProgress(): Promise<void> {
    if (!this.config.progress) return;
    await this.v1({ command: "clear_progress", tab: this.identity.workspaceId }, "progress");
  }

  async log(level: "info" | "success" | "warning" | "error", message: string): Promise<void> {
    if (!this.config.log) return;
    await this.v1({ command: "log", tab: this.identity.workspaceId, level, message });
  }

  async notify(title: string, body: string): Promise<void> {
    if (!this.config.notifications) return;
    await this.optional("notification.create_for_surface", {
      workspace_id: this.identity.workspaceId,
      surface_id: this.identity.surfaceId,
      title,
      body,
    });
  }

  async flash(): Promise<void> {
    if (!this.config.flash) return;
    await this.optional("surface.trigger_flash", {
      workspace_id: this.identity.workspaceId,
      surface_id: this.identity.surfaceId,
    }, "flash");
  }

  async setPiPid(): Promise<void> {
    await this.v1({
      command: "set_agent_pid",
      tab: this.identity.workspaceId,
      panel: this.identity.surfaceId,
      key: "pi",
      pid: process.pid,
    }, "pi:pid");
  }

  async lifecycle(lifecycle: "running" | "idle"): Promise<void> {
    await this.v1({
      command: "set_agent_lifecycle",
      tab: this.identity.workspaceId,
      panel: this.identity.surfaceId,
      key: "pi",
      lifecycle,
    }, "pi:lifecycle");
  }

  async clearPiPid(): Promise<void> {
    await this.v1({
      command: "clear_agent_pid",
      tab: this.identity.workspaceId,
      panel: this.identity.surfaceId,
      key: "pi",
    }, "pi:pid");
  }

  async meta(markdown: string): Promise<void> {
    if (!this.config.metaBlock) return;
    await this.v1({
      command: "report_meta_block",
      tab: this.identity.workspaceId,
      key: "pi-presence",
      markdown,
      priority: 50,
    }, "pi:meta");
  }

  async clearMeta(): Promise<void> {
    if (!this.config.metaBlock) return;
    await this.v1({
      command: "clear_meta_block",
      tab: this.identity.workspaceId,
      key: "pi-presence",
    }, "pi:meta");
  }

  async feed(
    event: "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop",
    sessionId: string,
    tool?: { callId?: string; name?: string },
  ): Promise<void> {
    if (!this.config.feed) return;

    const payload: Record<string, unknown> = {
      session_id: sessionId,
      hook_event_name: event,
      _source: "pi",
      workspace_id: this.identity.workspaceId,
      surface_id: this.identity.surfaceId,
    };
    const isToolEvent = event === "PreToolUse" || event === "PostToolUse";
    if (isToolEvent && tool?.callId) payload.tool_call_id = tool.callId;
    if (isToolEvent && tool?.name) payload.tool_name = tool.name;

    await this.optional("feed.push", {
      workspace_id: this.identity.workspaceId,
      surface_id: this.identity.surfaceId,
      event: payload,
    });
  }

  async autoTitle(title: string): Promise<void> {
    if (!this.config.autoTitle) return;
    await this.optional("workspace.set_auto_title", {
      workspace_id: this.identity.workspaceId,
      title,
    });
  }

  async installResumeFallback(sessionId: string, command: string): Promise<void> {
    const operation = this.installResumeFallbackNow(sessionId, command);
    this.resumeInstallOperation = operation;
    try {
      await operation;
    } finally {
      if (this.resumeInstallOperation === operation) this.resumeInstallOperation = null;
    }
  }

  async clearOwnedResumeFallback(sessionId: string): Promise<void> {
    const pendingInstall = this.resumeInstallOperation;
    if (pendingInstall) await pendingInstall.catch(() => {});
    if (!this.ownsResumeFallback
      || !this.config.resumeFallback
      || !this.supported.has("surface.resume.clear")) {
      return;
    }

    const verified = await this.getResume();
    if (verified?.checkpoint_id === sessionId) {
      await this.optional("surface.resume.clear", {
        workspace_id: this.identity.workspaceId,
        surface_id: this.identity.surfaceId,
        checkpoint_id: sessionId,
        source: "agent-hook",
      });
    }
    this.ownsResumeFallback = false;
  }

  async close(timeoutMs?: number): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closed = true;
    this.closeOperation = this.transport.close(timeoutMs);
    await this.closeOperation;
  }

  private async installResumeFallbackNow(sessionId: string, command: string): Promise<void> {
    if (!this.config.resumeFallback
      || !this.supported.has("surface.resume.get")
      || !this.supported.has("surface.resume.set")) {
      return;
    }

    const existing = await this.getResume();
    // Any unparseable/nonmatching binding is treated as occupied rather than overwritten.
    if (existing === undefined || (existing !== null && existing.checkpoint_id !== sessionId)) return;

    await this.optional("surface.resume.set", {
      workspace_id: this.identity.workspaceId,
      surface_id: this.identity.surfaceId,
      name: "Pi",
      checkpoint_id: sessionId,
      kind: "pi",
      source: "agent-hook",
      environment: {},
      command,
      auto_resume: true,
    });
    const verified = await this.getResume();
    this.ownsResumeFallback = verified !== undefined
      && verified !== null
      && verified.checkpoint_id === sessionId;
  }

  private async getResume(): Promise<ResumeBinding | null | undefined> {
    const result = await this.optional("surface.resume.get", {
      workspace_id: this.identity.workspaceId,
      surface_id: this.identity.surfaceId,
    });
    return result === undefined ? undefined : resumeBinding(result);
  }

  private async optional(
    method: V2Method,
    params: Record<string, unknown>,
    key?: string,
  ): Promise<unknown | undefined> {
    return this.supported.has(method) ? await this.v2(method, params, key) : undefined;
  }

  private async v1(command: V1Command, key?: string): Promise<void> {
    if (this.closed) return;
    try {
      decodeV1Response(await this.transport.request(encodeV1(command), key));
    } catch {
      // Best-effort observer.
    }
  }

  private async v2(
    method: V2Method,
    params: Record<string, unknown>,
    key?: string,
  ): Promise<unknown | undefined> {
    if (this.closed) return undefined;
    const id = this.nextId++;
    try {
      const response = await this.transport.request(encodeV2({ id, method, params }), key);
      return decodeV2Response(response, id);
    } catch {
      return undefined;
    }
  }
}
