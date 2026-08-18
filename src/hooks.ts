import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { EVENT_NAMES } from "@pi/presence";
import type { PresenceRuntime } from "./runtime.js";
/** Register passive TUI lifecycle and V2 consumer listeners before any session activates. */
export function registerPresenceHooks(pi: ExtensionAPI, runtime: PresenceRuntime): void {
 for (const name of [EVENT_NAMES.state, EVENT_NAMES.terminal, EVENT_NAMES.withdraw]) pi.events.on(name,payload=>runtime.handlePresenceEvent(name,payload));
 pi.events.on(EVENT_NAMES.consumerReady,payload=>runtime.handleConsumerReady(payload));
 pi.on("agent_settled", (_event, context) => runtime.handleAgentSettled(context));
 // Lifecycle callbacks are observer-only: never make Pi await probe or socket work.
 pi.on("session_start", (event, context) => { void runtime.startSession(context, event).catch(() => {}); });
 pi.on("agent_start", (_event, context) => runtime.handleAgentStart(context));
 pi.on("turn_start", (_event, context) => runtime.handleTurnStart(context));
 pi.on("message_end", (event, context) => runtime.handleMessageEnd(event, context));
 pi.on("agent_end", (event, context) => runtime.handleAgentEnd(event, context));
 pi.on("tool_result", (event, context) => runtime.handleToolResult(event, context));
 pi.on("session_shutdown", (_event, context) => { void runtime.shutdownSession(context).catch(() => {}); });
}
