import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PI_PRESENCE_READY_EVENT, PI_PRESENCE_REMOVE_EVENT, PI_PRESENCE_UPDATE_EVENT } from "./events.js";
import type { PresenceRuntime } from "./runtime.js";
/** Register passive TUI lifecycle and generic event observers. */
export function registerPresenceHooks(pi: ExtensionAPI, runtime: PresenceRuntime): void {
 pi.events.on(PI_PRESENCE_UPDATE_EVENT,p=>runtime.handlePresenceUpdate(p)); pi.events.on(PI_PRESENCE_REMOVE_EVENT,p=>runtime.handlePresenceRemove(p)); pi.events.on(PI_PRESENCE_READY_EVENT,p=>runtime.handleReady(p)); pi.events.on("herdr:blocked",p=>runtime.handleBlocked(p));
 let fallback=false;try{pi.on("agent_settled",(_e,c)=>runtime.handleAgentSettled(c));}catch{fallback=true;}
 pi.on("session_start",(e,c)=>runtime.startSession(c,e));pi.on("agent_start",(_e,c)=>runtime.handleAgentStart(c));pi.on("turn_start",(_e,c)=>runtime.handleTurnStart(c));pi.on("message_end",e=>runtime.handleMessageEnd(e));pi.on("agent_end",e=>{runtime.handleAgentEnd(e);if(fallback)runtime.handleAgentEndFallback();});pi.on("tool_result",e=>runtime.handleToolResult(e));pi.on("session_shutdown",()=>runtime.shutdownSession());
}
