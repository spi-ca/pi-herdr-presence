import type { PresenceUpdate } from "./events.js";
import type { SubagentSummary } from "./subagent-summary.js";
import { boundedPresenceText } from "./text.js";
export type HerdrState = "idle" | "working" | "blocked" | "unknown";
export type BlockedCategory = "ask-user" | "blocked";
const LOCAL: Record<PresenceUpdate["state"],string>={idle:"Idle",waiting:"Waiting",running:"Working",success:"Done",error:"Needs attention",cancelled:"Cancelled"};
/** Retained interaction state blocks even when a replay intentionally clears attention. */
export function isInteractionWaiting(event:PresenceUpdate):boolean{return event.source.kind==="interaction"&&event.state==="waiting";}
/** Only a live info update is eligible to notify; replays with attention:none are silent. */
export function isLiveInputRequest(event:PresenceUpdate):boolean{return isInteractionWaiting(event)&&event.attention==="info";}
export function blockedPresentationCategory(events:readonly PresenceUpdate[],nativeCategory?:BlockedCategory):BlockedCategory {if(events.some(e=>e.state==="error"||e.attention==="error")||nativeCategory==="blocked")return "blocked";return nativeCategory==="ask-user"||events.some(isInteractionWaiting)?"ask-user":"blocked";}
const isSubagent=(event:PresenceUpdate)=>event.source.id==="pi-subagent";
const hasError=(event:PresenceUpdate)=>event.state==="error"||event.attention==="error";
function subagentEvent(events:readonly PresenceUpdate[]){return events.find(isSubagent);}
/** Only the exact aggregate producer may affect parent subagent presentation. */
function subagentStatus(events:readonly PresenceUpdate[],summary:SubagentSummary|null){const event=subagentEvent(events);if(!event&&!summary)return null;const active=event?.counts.active??(summary?summary.active.length+summary.omitted:0);const queued=event?.counts.queued??(summary?.waiting?.category==="queued"?summary.waiting.count:0);const cancelling=event?.state==="cancelled"||summary?.active.some(item=>item.category==="cancelling")===true||summary?.waiting?.category==="cancelling";const failed=event!==undefined&&hasError(event)||summary?.terminal?.status==="failed";return {active,queued,cancelling,failed};}
function hasHigherPriorityIssue(events:readonly PresenceUpdate[],nativeCategory?:BlockedCategory){return nativeCategory==="blocked"||events.some(event=>!isSubagent(event)&&(hasError(event)||isInteractionWaiting(event)));}
export function compositeState(events: readonly PresenceUpdate[], active: boolean, locallyBlocked=false): HerdrState { if(locallyBlocked || events.some(event=>!isSubagent(event)&&hasError(event)))return "blocked"; if(events.some(isInteractionWaiting))return "blocked"; if(active || events.some(e=>e.state==="running" || e.state==="waiting"))return "working"; if(events.some(event=>isSubagent(event)&&hasError(event)))return "blocked"; return "idle"; }
/** Native blocked labels are never forwarded: only an allowlisted category selects wording. */
export function safeMessage(state:HerdrState,max:number,blockedCategory?:BlockedCategory,events:readonly PresenceUpdate[]=[],summary:SubagentSummary|null=null):string { const category=blockedPresentationCategory(events,blockedCategory);const subagents=subagentStatus(events,summary);const text=state==="blocked" ? (subagents?.failed&&!hasHigherPriorityIssue(events,blockedCategory)?"Subagent needs attention":category==="ask-user"?"Pi needs your input":"Pi needs attention") : state==="working"&&subagents ? (subagents.cancelling?"Subagents are stopping":subagents.active>0?"Subagents are working":subagents.queued>0?"Subagents are queued":"Pi is working") : state==="working" ? "Pi is working" : state==="idle" ? "Pi is idle" : "Pi state unknown";return boundedPresenceText(text,{maxBytes:128,maxCodePoints:max}); }
function summaryTokens(summary: SubagentSummary | null): Record<string,string|null> {
 if (!summary) return {subagents:null,subagent_wait:null,subagent_error:null,subagent_terminal:null,subagent_terminal_at:null};
 const total=summary.active.length+summary.omitted;
 const terminalDate=summary.terminal ? new Date(summary.terminal.completedAt) : null;
 const terminalAt=terminalDate && Number.isFinite(terminalDate.getTime()) ? terminalDate.toISOString() : null;
 return {
  subagents:String(total),
  subagent_wait:summary.waiting ? `${summary.waiting.category}:${summary.waiting.count}` : null,
  subagent_error:summary.terminal?.status === "failed" ? "1" : null,
  subagent_terminal:summary.terminal?.status ?? null,
  subagent_terminal_at:terminalAt,
 };
}
/** Metadata is deliberately count/category-only; companion task, agent, and identifier fields never reach Herdr. */
export function metadata(events:readonly PresenceUpdate[], state:HerdrState,max:number,summary:SubagentSummary|null=null,blockedCategory?:BlockedCategory){ const count=(k:keyof PresenceUpdate["counts"])=>events.reduce((n,e)=>n+(typeof e.counts[k]==="number"?e.counts[k] as number:0),0);const tokens=events.reduce((n,e)=>n+(e.usage?.tokens??0),0);const cost=events.reduce((n,e)=>n+(e.usage?.cost??0),0);const context=Math.max(0,...events.map(e=>e.usage?.contextPercent??0));const progress=events.find(e=>e.source.id==="pi-todo"&&e.progress)??events.find(e=>e.progress&&(e.state==="running"||e.state==="waiting")); const category=blockedPresentationCategory(events,blockedCategory);const labels:Record<string,string>={idle:"Idle",working:"Working",blocked:category==="ask-user"?"Input needed":"Needs attention",unknown:"Unknown"};const subagents=subagentStatus(events,summary);const subagentTitle=subagents&&!hasHigherPriorityIssue(events,blockedCategory)?subagents.failed?"Pi · Subagent failed":subagents.cancelling?"Pi · Subagents stopping":subagents.active>0&&subagents.queued>0?`Pi · ${subagents.active} running · ${subagents.queued} queued`:subagents.active>0?`Pi · ${subagents.active} running`:subagents.queued>0?`Pi · ${subagents.queued} queued`:summary?`Pi · ${summary.active.length+summary.omitted} subagents`:null:null; return {title:boundedPresenceText(subagentTitle??`Pi · ${labels[state]}`,{maxBytes:128,maxCodePoints:max}),displayAgent:"Pi",labels,tokens:{active:String(count("active")),completed:String(count("completed")),failed:String(count("failed")),queued:String(count("queued")),cancelled:String(count("cancelled")),total:String(count("total")),progress:progress?.progress?`${Math.round(progress.progress.value*100)}%`:null,tokens:tokens?String(Math.round(tokens)):null,cost:cost?cost.toFixed(2):null,context:context?`${Math.round(context)}%`:null,...summaryTokens(summary)}}; }
export function attentionText(event:PresenceUpdate,max:number):{title:string;body:string;error:boolean;inputNeeded:boolean}|null { if(event.attention!=="error"&&event.attention!=="success"&&event.attention!=="info")return null; const inputNeeded=isLiveInputRequest(event);const error=event.attention==="error"; return {title:boundedPresenceText(inputNeeded?"Pi needs your input":error?"Pi needs attention":"Pi update",{maxBytes:128,maxCodePoints:max}),body:boundedPresenceText(inputNeeded?"Pi needs your input":error?"A Pi task needs attention":"Pi activity completed",{maxBytes:512,maxCodePoints:max}),error,inputNeeded}; }
export function localStateText(state:PresenceUpdate["state"],max:number){return boundedPresenceText(LOCAL[state],{maxBytes:128,maxCodePoints:max});}
