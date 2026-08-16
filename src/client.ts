import type { PresenceConfig } from "./config.js";
import type { HerdrIdentity } from "./identity.js";
import { decodeHerdrResponse, encodeHerdrRequest, type HerdrMethod } from "./protocol.js";
import { HerdrSocketTransport, PresenceTransportError } from "./transport.js";

/** This extension takes over the official Pi authority only while it is absent. */
export const LIFECYCLE_SOURCE = "herdr:pi";
const OWNED_METADATA_TOKENS = ["active", "completed", "failed", "queued", "cancelled", "total", "progress", "tokens", "cost", "context"] as const;
export type SessionRef = { agent_session_path: string } | { agent_session_id: string };

/** One request per connection is enforced by HerdrSocketTransport; this client never subscribes. */
export class PresenceClient {
  private sequence = Math.floor(Date.now() * 1000); private requestNumber = 0; private closed = false; private keyRevisions = new Map<string, number>();
  constructor(private readonly identity: HerdrIdentity, private readonly transport: HerdrSocketTransport, private readonly config: PresenceConfig) {}
  async reportSession(sessionRef: SessionRef, reason?: string): Promise<void> { await this.send("pane.report_agent_session", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next(), ...(reason ? {session_start_source:reason}: {}), ...sessionRef }, "session"); }
  async report(state: "idle"|"working"|"blocked"|"unknown", sessionRef: SessionRef, message?: string): Promise<void> { await this.send("pane.report_agent", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", state, ...(message ? {message}: {}), seq:this.next(), ...sessionRef }, "agent"); }
  async metadata(data: { title:string; displayAgent:string; labels:Record<string,string>; tokens:Record<string,string|null> }): Promise<void> { if(!this.config.metadata)return; await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next(), title:data.title, display_agent:data.displayAgent, state_labels:data.labels, tokens:data.tokens }, "metadata"); }
  /** Schema clear flags withdraw fields; null token patches withdraw the individual values. */
  async clearMetadata(): Promise<void> { if(!this.config.metadata)return; await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next(), clear_title:true, clear_display_agent:true, clear_state_labels:true, tokens:Object.fromEntries(OWNED_METADATA_TOKENS.map((token)=>[token,null])) }, "metadata-clear", true); }
  async notify(title:string, body:string, error=false): Promise<void> { if(!this.config.notifications)return; await this.send("notification.show", { title, body, sound:error ? "request":"done" }, "notification"); }
  /** Release is priority queued so an already saturated observer queue cannot strand owned state. */
  async release(): Promise<void> { await this.send("pane.release_agent", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", seq:this.next() }, "release", true); }
  async close(timeoutMs?:number): Promise<void> { this.closed=true; await this.transport.close(timeoutMs); }
  private next(){ this.sequence = Math.min(Number.MAX_SAFE_INTEGER, this.sequence + 1); return this.sequence; }
  /** Exactly two attempts share the configured connection/response timeout budget. */
  private async send(method: HerdrMethod, params: Record<string,unknown>, key:string, priority=false): Promise<void> {
    if(this.closed)return;
    const revision=(this.keyRevisions.get(key)??0)+1;
    this.keyRevisions.set(key,revision);
    const id=`${LIFECYCLE_SOURCE}:${++this.requestNumber}`;
    const line=encodeHerdrRequest({id,method,params});
    const firstTimeout=Math.floor(this.config.timeoutMs/2);
    const retryTimeout=this.config.timeoutMs-firstTimeout;
    try { const response=await this.transport.request(line,key,priority,firstTimeout); decodeHerdrResponse(response,id); }
    catch (error) {
      // A stale failure must not enqueue a retry that replaces a newer keyed write.
      if(this.closed || this.keyRevisions.get(key)!==revision || (error instanceof PresenceTransportError && /^Socket queue (coalesced|displaced|closed|is full)/.test(error.message)))return;
      try { decodeHerdrResponse(await this.transport.request(line,key,priority,retryTimeout),id); } catch { /* output-only best effort */ }
    }
  }
}
