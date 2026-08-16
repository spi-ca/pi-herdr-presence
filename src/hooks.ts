import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_PRESENCE_READY_EVENT, PI_PRESENCE_REMOVE_EVENT, PI_PRESENCE_UPDATE_EVENT } from "./events.js";
import type { PresenceRuntime } from "./runtime.js";

/** Register Pi and process-local observers without owning mutable presence state. */
export function registerPresenceHooks(pi: ExtensionAPI, runtime: PresenceRuntime): void {
  pi.events.on(PI_PRESENCE_UPDATE_EVENT, (payload) => runtime.handlePresenceUpdate(payload));
  pi.events.on(PI_PRESENCE_REMOVE_EVENT, (payload) => runtime.handlePresenceRemove(payload));
  pi.events.on(PI_PRESENCE_READY_EVENT, (payload) => runtime.handleReady(payload));

  let settleOnAgentEnd = false;
  try {
    pi.on("agent_settled", (_event, context) => runtime.handleAgentSettled(context));
  } catch {
    // Only older/incomplete hosts that reject this registration use agent_end as a fallback.
    settleOnAgentEnd = true;
  }

  pi.on("session_start", async (_event, context) => runtime.startSession(context));
  pi.on("agent_start", () => runtime.handleAgentStart());
  pi.on("turn_start", () => runtime.handleTurnStart());
  pi.on("message_end", (event) => runtime.handleMessageEnd(event));
  pi.on("agent_end", (event) => {
    runtime.handleAgentEnd(event);
    if (settleOnAgentEnd) runtime.handleAgentEndFallback();
  });
  pi.on("before_agent_start", () => runtime.handleBeforeAgentStart());
  pi.on("tool_execution_start", (event) => runtime.handleToolExecutionStart(event));
  pi.on("tool_execution_end", (event) => runtime.handleToolExecutionEnd(event));
  pi.on("tool_result", (event) => runtime.handleToolResult(event));
  pi.on("session_info_changed", (event) => runtime.handleSessionInfoChanged(event));
  pi.on("session_shutdown", async () => runtime.shutdownSession());
}
