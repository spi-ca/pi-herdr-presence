import type { PresenceConfig } from "./config.js";
import type { HerdrIdentity } from "./identity.js";
import { decodeHerdrResponse, encodeHerdrRequest, type HerdrMethod } from "./protocol.js";
import { HerdrSocketTransport, PresenceTransportError } from "./transport.js";
import { hasControlOrBidi } from "./validation.js";

/** This extension takes over the official Pi authority only while it is absent. */
export const LIFECYCLE_SOURCE = "herdr:pi";
const OWNED_METADATA_TOKENS = ["active", "completed", "failed", "queued", "cancelled", "total", "progress", "tokens", "cost", "context", "subagents", "subagent_wait", "subagent_error", "subagent_terminal", "subagent_terminal_at"] as const;
export type SessionRef = { agent_session_path: string } | { agent_session_id: string };

/** One request per connection is enforced by HerdrSocketTransport; this client never subscribes. */
export class PresenceClient {
  private sequence = Math.floor(Date.now() * 1000); private requestNumber = 0; private closed = false; private closing = false; private teardownPromise:Promise<void>|null=null; private keyRevisions = new Map<string, number>();
  constructor(private readonly identity: HerdrIdentity, private readonly transport: HerdrSocketTransport, private readonly config: PresenceConfig) {}
  async reportSession(sessionRef: SessionRef, reason?: string): Promise<void> { await this.send("pane.report_agent_session", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next(), ...(safeSessionStartReason(reason) ? {session_start_source:reason}: {}), ...sessionRef }, "session"); }
  async report(state: "idle"|"working"|"blocked"|"unknown", sessionRef: SessionRef, message?: string): Promise<void> { await this.send("pane.report_agent", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", state, ...(message ? {message}: {}), seq:this.next(), ...sessionRef }, "agent"); }
  async metadata(data: { title:string; displayAgent:string; labels:Record<string,string>; tokens:Record<string,string|null> }): Promise<void> { if(!this.config.metadata)return; await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next(), title:data.title, display_agent:data.displayAgent, state_labels:data.labels, tokens:data.tokens }, "metadata"); }
  /** Schema clear flags withdraw fields; null token patches withdraw the individual values. */
  async clearMetadata(): Promise<void> { if(!this.config.metadata)return; await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next(), clear_title:true, clear_display_agent:true, clear_state_labels:true, tokens:Object.fromEntries(OWNED_METADATA_TOKENS.map((token)=>[token,null])) }, "metadata-clear", true, true, true); }
  /** A dispatched notification has an unknown user-visible outcome, so it is never retried. */
  async notify(title:string, body:string, error=false): Promise<void> { if(!this.config.notifications)return; await this.send("notification.show", { title, body, sound:error ? "request":"done" }, "notification", false, false); }
  /** Release is priority queued so an already saturated observer queue cannot strand owned state. */
  async release(): Promise<void> { await this.send("pane.release_agent", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next() }, "release", true, true, true); }
  /** Clear then release within one deadline; expiry aborts the transport and prevents later dispatch. */
  teardown(timeoutMs=this.config.timeoutMs): Promise<void> {
   if(this.teardownPromise)return this.teardownPromise;
   if(this.closed)return Promise.resolve();
   // Fence ordinary reports and their retries before cleanup enters the queue.
   this.closing=true;
   this.teardownPromise=this.performTeardown(timeoutMs);
   return this.teardownPromise;
  }
  private async performTeardown(timeoutMs:number):Promise<void>{
   const budget=Number.isFinite(timeoutMs)?Math.max(0,timeoutMs):this.config.timeoutMs;
   if(budget<=0){await this.close(0).catch(()=>{});return;}
   const deadlineAt=Date.now()+budget;let expired=false;let timer:ReturnType<typeof setTimeout>|undefined;
   const expires=new Promise<void>(resolve=>{timer=setTimeout(()=>{expired=true;void this.close(0).catch(()=>{});resolve();},budget);timer.unref?.();});
   try {
    await Promise.race([this.clearMetadata().catch(()=>{}),expires]);
    if(!expired&&!this.closed)await Promise.race([this.release().catch(()=>{}),expires]);
    if(!expired&&!this.closed)await Promise.race([this.close(Math.max(0,deadlineAt-Date.now())).catch(()=>{}),expires]);
   } finally {
    if(timer)clearTimeout(timer);
    // `expires` may leave a cleanup request running against a non-cooperative
    // transport mock. It is contained above, and close prevents any retry.
   }
  }
  async close(timeoutMs?:number): Promise<void> { this.closing=true;this.closed=true; await this.transport.close(timeoutMs); }
  private next(){ this.sequence = Math.min(Number.MAX_SAFE_INTEGER, this.sequence + 1); return this.sequence; }
  /** Lifecycle requests use two attempts; notifications deliberately use one. */
  private async send(method: HerdrMethod, params: Record<string,unknown>, key:string, priority=false, retry=true, cleanup=false): Promise<void> {
    if(this.closed||(this.closing&&!cleanup))return;
    const revision=(this.keyRevisions.get(key)??0)+1;
    this.keyRevisions.set(key,revision);
    const id=`${LIFECYCLE_SOURCE}:${++this.requestNumber}`;
    let line: string;
    // Validation and serialization are output-only too: never dispatch or reject lifecycle work.
    try { line=encodeHerdrRequest({id,method,params}); } catch { return; }
    const firstTimeout=Math.floor(this.config.timeoutMs/2);
    const retryTimeout=this.config.timeoutMs-firstTimeout;
    try { const response=await this.transport.request(line,key,priority,firstTimeout); decodeHerdrResponse(response,id); }
    catch (error) {
      // Transport does not distinguish pre-dispatch failures from timeout/EOF.
      // Retrying notification.show could duplicate a visible alert, so do not
      // guess: notifications always stop after their one attempt.
      if(!retry || this.closed || this.closing || this.keyRevisions.get(key)!==revision || (error instanceof PresenceTransportError && /^Socket queue (coalesced|displaced|closed|is full)/.test(error.message)))return;
      try { decodeHerdrResponse(await this.transport.request(line,key,priority,retryTimeout),id); } catch { /* output-only best effort */ }
    }
  }
}

function safeSessionStartReason(reason: unknown): reason is string { return typeof reason==="string" && reason.length>0 && Buffer.byteLength(reason,"utf8")<=512 && !hasControlOrBidi(reason); }
