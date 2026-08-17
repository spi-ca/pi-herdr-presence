import type { PresenceUpdate } from "./events.js";
/** Exact producer identity; labels/kinds never grant special routing authority. */
export const PI_SUBAGENT_SOURCE_ID = "pi-subagent";
export type NotificationPolicy = "errors" | "background" | "settled" | "all" | "disabled";
export type AttentionKind = "success" | "error";
export type NotificationSeverity = "error" | "attention" | "success" | "info" | "long-running";
export type NotificationCooldownKind = "error" | "input" | "blocked" | "other";
export interface SubagentTerminalBaseline { readonly generation:number; readonly completed:number; readonly failed:number; readonly cancelled:number; }
export interface SubagentObservation { readonly baseline:SubagentTerminalBaseline; readonly terminal:AttentionKind|null; readonly completedDelta:number; readonly failedDelta:number; readonly reset:boolean; readonly generationChanged:boolean; readonly unknownCount:boolean; }
const baseline=(e:PresenceUpdate):SubagentTerminalBaseline=>({generation:e.generation,completed:e.counts.completed,failed:e.counts.failed,cancelled:e.counts.cancelled??0});
/** Interpret only pi-subagent's cumulative counters; cancellation has no attention. */
export function observeSubagentTerminal(previous:SubagentTerminalBaseline|null,event:PresenceUpdate):SubagentObservation {const next=baseline(event);const attention=event.state==="cancelled"?null:event.attention==="error"?"error":event.attention==="success"||event.attention==="info"?"success":null;if(event.source.id!==PI_SUBAGENT_SOURCE_ID)return{baseline:next,terminal:null,completedDelta:0,failedDelta:0,reset:false,generationChanged:false,unknownCount:false};if(!previous||previous.generation!==event.generation)return{baseline:next,terminal:attention,completedDelta:0,failedDelta:0,reset:false,generationChanged:previous!==null,unknownCount:attention!==null};const completed=event.counts.completed-previous.completed,failed=event.counts.failed-previous.failed,cancelled=(event.counts.cancelled??0)-previous.cancelled;if(completed<0||failed<0||cancelled<0)return{baseline:next,terminal:null,completedDelta:0,failedDelta:0,reset:true,generationChanged:false,unknownCount:false};const terminal=attention==="error"&&failed>0?"error":attention==="success"&&completed>0?"success":null;return{baseline:next,terminal,completedDelta:terminal?completed:0,failedDelta:terminal?failed:0,reset:false,generationChanged:false,unknownCount:false};}
/** Policy is evaluated after static safe rendering and before local bounded deduplication. */
export function shouldNotify(policy:NotificationPolicy,enabled:boolean,severity:NotificationSeverity,origin:"local"|"external"):boolean {if(!enabled||policy==="disabled")return false;if(severity==="error"||severity==="attention")return true;if(policy==="errors")return false;if(policy==="all")return true;if(policy==="settled")return severity==="success"&&origin==="local";return origin==="external"||severity==="long-running";}
/** Backward-compatible attention policy facade, including legacy merged success semantics. */
export function shouldNotifyAttention(policy:NotificationPolicy,enabled:boolean,attention:PresenceUpdate["attention"],origin:"local"|"external",merged=false):boolean {if(!enabled||policy==="disabled"||!attention||attention==="none")return false;if(policy==="errors")return attention==="error";if(policy==="all")return true;if(policy==="settled")return attention==="error"||(attention==="success"&&(origin==="local"||merged));return origin==="external"||attention==="error"||merged;}
/** Fixed-size TTL/LRU gate: duplicate notifications never become an unbounded registry. */
export class NotificationDeduper {
 private readonly entries=new Map<string,number>();
 constructor(private readonly ttlMs=60_000,private readonly limit=64){}
 accept(key:string,now=Date.now()):boolean {for(const [candidate,expires] of this.entries){if(expires<=now)this.entries.delete(candidate);}const expires=this.entries.get(key);if(expires!==undefined){this.entries.delete(key);this.entries.set(key,expires);return false;}this.entries.set(key,now+this.ttlMs);while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);return true;}
 canAccept(key:string,now=Date.now()):boolean {for(const [candidate,expires] of this.entries){if(expires<=now)this.entries.delete(candidate);}return !this.entries.has(key);}
 get size(){return this.entries.size;}
 clear(){this.entries.clear();}
}
/** Fixed-window session backstop. First actionable kinds bypass exhaustion, but never reset it. */
export class NotificationRateLimiter {
 private timestamps:number[]=[];
 private readonly actionable=new Set<Exclude<NotificationCooldownKind,"other">>();
 constructor(private readonly windowMs=60_000,private readonly limit=8){}
 accept(kind:NotificationCooldownKind,now=Date.now()):boolean {this.timestamps=this.timestamps.filter(timestamp=>timestamp+this.windowMs>now);if(kind!=="other"&&!this.actionable.has(kind)){this.actionable.add(kind);return true;}if(this.timestamps.length>=this.limit)return false;this.timestamps.push(now);return true;}
 get size(){return this.timestamps.length;}
 clear(){this.timestamps=[];this.actionable.clear();}
}
/** Bounded per-source semantic fence; higher sequences alone never make a new alert. */
export class ExternalAttentionTransitions {
 private readonly entries=new Map<string,{generation:number;attention:Exclude<PresenceUpdate["attention"],"none">}>();
 constructor(private readonly limit=64){}
 accept(sourceId:string,generation:number,attention:PresenceUpdate["attention"]):boolean {
  if(attention!=="error"&&attention!=="success"&&attention!=="info"){this.entries.delete(sourceId);return false;}
  const previous=this.entries.get(sourceId);
  if(previous?.generation===generation&&previous.attention===attention)return false;
  this.entries.delete(sourceId);this.entries.set(sourceId,{generation,attention});
  while(this.entries.size>this.limit)this.entries.delete(this.entries.keys().next().value!);
  return true;
 }
 remove(sourceId:string){this.entries.delete(sourceId);}
 clear(){this.entries.clear();}
}
