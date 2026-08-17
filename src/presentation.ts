import type { PresenceUpdate } from "./events.js";
import type { SubagentSummary } from "./subagent-summary.js";
import { boundedPresenceText } from "./text.js";
export type HerdrState = "idle" | "working" | "blocked" | "unknown";
const LOCAL: Record<PresenceUpdate["state"],string>={idle:"Idle",waiting:"Waiting",running:"Working",success:"Done",error:"Needs attention",cancelled:"Cancelled"};
export function compositeState(events: readonly PresenceUpdate[], active: boolean, locallyBlocked=false): HerdrState { if(locallyBlocked || events.some(e=>e.state==="error" || e.attention==="error"))return "blocked"; if(active || events.some(e=>e.state==="running" || e.state==="waiting"))return "working"; return "idle"; }
/** Native blocked labels are never forwarded: only an allowlisted category selects wording. */
export function safeMessage(state:HerdrState,max:number,blockedCategory?:"ask-user"|"blocked"):string { return boundedPresenceText(state==="blocked" ? (blockedCategory==="ask-user" ? "Pi needs your input" : "Pi needs attention") : state==="working" ? "Pi is working" : state==="idle" ? "Pi is idle" : "Pi state unknown",{maxBytes:128,maxCodePoints:max}); }
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
export function metadata(events:readonly PresenceUpdate[], state:HerdrState,max:number,summary:SubagentSummary|null=null){ const count=(k:keyof PresenceUpdate["counts"])=>events.reduce((n,e)=>n+(typeof e.counts[k]==="number"?e.counts[k] as number:0),0);const tokens=events.reduce((n,e)=>n+(e.usage?.tokens??0),0);const cost=events.reduce((n,e)=>n+(e.usage?.cost??0),0);const context=Math.max(0,...events.map(e=>e.usage?.contextPercent??0));const progress=events.find(e=>e.source.id==="pi-todo"&&e.progress)??events.find(e=>e.progress&&(e.state==="running"||e.state==="waiting")); const labels:Record<string,string>={idle:"Idle",working:"Working",blocked:"Needs attention",unknown:"Unknown"}; return {title:boundedPresenceText(`Pi · ${labels[state]}`,{maxBytes:128,maxCodePoints:max}),displayAgent:"Pi",labels,tokens:{active:String(count("active")),completed:String(count("completed")),failed:String(count("failed")),queued:String(count("queued")),cancelled:String(count("cancelled")),total:String(count("total")),progress:progress?`${Math.round(progress.progress!.value*100)}%`:null,tokens:tokens?String(Math.round(tokens)):null,cost:cost?cost.toFixed(2):null,context:context?`${Math.round(context)}%`:null,...summaryTokens(summary)}}; }
export function attentionText(event:PresenceUpdate,max:number):{title:string;body:string;error:boolean}|null { if(event.attention!=="error"&&event.attention!=="success"&&event.attention!=="info")return null; const error=event.attention==="error"; return {title:boundedPresenceText(error?"Pi needs attention":"Pi update",{maxBytes:128,maxCodePoints:max}),body:boundedPresenceText(error?"A Pi task needs attention":"Pi activity completed",{maxBytes:512,maxCodePoints:max}),error}; }
export function localStateText(state:PresenceUpdate["state"],max:number){return boundedPresenceText(LOCAL[state],{maxBytes:128,maxCodePoints:max});}
