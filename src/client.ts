import type { PresenceConfig } from "./config.js";
import type { HerdrIdentity } from "./identity.js";
import { decodeHerdrResponse, encodeHerdrRequest, HERDR_LEGACY_METADATA_TOKEN_KEYS, HERDR_METADATA_TOKEN_KEYS, type HerdrMetadataTokens, type HerdrMethod, type HerdrPresentation } from "./protocol.js";
import { HerdrSocketTransport, PresenceTransportError } from "./transport.js";
import { processCoordinator } from "./process-coordinator.js";
import { hasControlOrBidi } from "./validation.js";

/** This extension takes over the official Pi authority only while it is absent. */
export const LIFECYCLE_SOURCE = "herdr:pi";
export const OWNED_METADATA_TOKENS = HERDR_METADATA_TOKEN_KEYS;
export const LEGACY_METADATA_TOKENS = HERDR_LEGACY_METADATA_TOKEN_KEYS;
/** Herdr's fixed session projection is intentionally ID-only; paths are never sent. */
export type SessionRef = { agent_session_id: string };

/** One request per connection is enforced by HerdrSocketTransport; this client never subscribes. */
export class PresenceClient {
  private requestNumber = 0; private closed = false; private closing = false; private teardownPromise:Promise<void>|null=null; private keyRevisions = new Map<string, number>(); private legacyMetadataClear: Promise<void> | null = null; private startupMetadataClear: Promise<void> | null = null; private sessionAuthorityPrepared = false; private normalMetadataStarted = false;
  constructor(private readonly identity: HerdrIdentity, private readonly transport: HerdrSocketTransport, private readonly config: PresenceConfig) {}
  async reportSession(sessionRef: SessionRef, reason?: string): Promise<void> { const seq=this.next(); if(seq===undefined)return; await this.send("pane.report_agent_session", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", seq, ...(safeSessionStartReason(reason) ? {session_start_source:reason}: {}), ...sessionRef }, "session"); }
  async report(state: "idle"|"working"|"blocked"|"unknown", sessionRef: SessionRef, message?: string): Promise<void> { const seq=this.next(); if(seq===undefined)return; await this.send("pane.report_agent", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, agent:"pi", state, ...(message ? {message}: {}), seq, ...sessionRef }, "agent"); }
  /** Herdr v8 renders only fixed, privacy-safe presentation fields plus the complete V2 token patch. */
  async metadata(presentation: HerdrPresentation, tokens: HerdrMetadataTokens): Promise<void> {
    if(!this.config.metadata)return;
    // Await only incomplete startup work. Once its successful completion is
    // recorded, a live metadata edge must enter the transport queue in this
    // call stack, ahead of any following best-effort notification.
    const preparation=this.prepareSessionAuthority();
    if(!this.sessionAuthorityPrepared) await preparation;
    this.normalMetadataStarted=true;
    const seq=this.next();
    if(seq===undefined)return;
    await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq, title:presentation.title, display_agent:presentation.displayAgent, state_labels:presentation.labels, tokens }, "metadata");
  }
  /**
   * Clear both owned V2 chunks before this client restores pane authority.
   * They are separate exact requests because the legacy chunk has 12 keys and
   * the current chunk has 9, preserving the 16-token request bound.
   */
  prepareSessionAuthority(): Promise<void> {
    if(this.sessionAuthorityPrepared || this.normalMetadataStarted)return Promise.resolve();
    if(!this.startupMetadataClear) this.startupMetadataClear=(async()=>{
      await this.clearCurrentMetadata("metadata-startup-clear", false);
      await this.clearLegacyMetadata();
      this.sessionAuthorityPrepared=true;
    })();
    return this.startupMetadataClear;
  }
  /** Clear pre-V2-only owned tokens once before normal presentation; it never retries. */
  clearLegacyMetadata(): Promise<void> {
    if(this.normalMetadataStarted || this.legacyMetadataClear)return this.legacyMetadataClear??Promise.resolve();
    const seq=this.next();
    if(seq===undefined)return Promise.resolve();
    this.legacyMetadataClear=this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq, tokens:Object.fromEntries(LEGACY_METADATA_TOKENS.map((token)=>[token,null])) }, "metadata-legacy-clear", false, false, true);
    return this.legacyMetadataClear;
  }
  /** Explicitly clear every owned presentation field and null every fixed token. */
  async clearMetadata(): Promise<void> { await this.clearCurrentMetadata("metadata-clear"); }
  private async clearCurrentMetadata(key:string, retry=true): Promise<void> { const seq=this.next(); if(seq===undefined)return; await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq, clear_title:true, clear_display_agent:true, clear_state_labels:true, tokens:Object.fromEntries(OWNED_METADATA_TOKENS.map((token)=>[token,null])) }, key, true, retry, true); }
  /** Teardown repeats the exact legacy chunk even after normal metadata started. */
  private async clearLegacyMetadataOnTeardown(): Promise<void> { const seq=this.next(); if(seq===undefined)return; await this.send("pane.report_metadata", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, applies_to_source:LIFECYCLE_SOURCE, agent:"pi", seq, tokens:Object.fromEntries(LEGACY_METADATA_TOKENS.map((token)=>[token,null])) }, "metadata-teardown-legacy-clear", true, false, true); }
  /** A visible toast has unknown delivery after dispatch, so it is never retried. */
  async notify(title:string, body:string, error=false, key="default"): Promise<void> { if(!this.config.notifications)return; await this.send("notification.show", { title, body, sound:error ? "request":"done" }, `notification:${key}`, false, false); }
  /** Herdr's existing authority clear is priority cleanup and is never retried. */
  private async clearAgentAuthority(): Promise<void> { const seq=this.next(); if(seq===undefined)return; await this.send("pane.clear_agent_authority", { pane_id:this.identity.paneId, source:LIFECYCLE_SOURCE, seq }, "clear-agent-authority", true, false, true); }
  /** Clear metadata then authority within one deadline; expiry aborts later dispatch. */
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
    if(!expired&&!this.closed)await Promise.race([this.clearLegacyMetadataOnTeardown().catch(()=>{}),expires]);
    if(!expired&&!this.closed)await Promise.race([this.clearAgentAuthority().catch(()=>{}),expires]);
    const remaining=deadlineAt-Date.now();
    if(!expired&&!this.closed)await Promise.race([this.close(Number.isFinite(remaining)?Math.max(0,remaining):0).catch(()=>{}),expires]);
   } finally {
    if(timer)clearTimeout(timer);
    // `expires` may leave a cleanup request running against a non-cooperative
    // transport mock. It is contained above, and close prevents any retry.
   }
  }
  async close(timeoutMs?:number): Promise<void> { this.closing=true;this.closed=true; await this.transport.close(timeoutMs); }
  private next(): number | undefined {
    try {
      const sequence = processCoordinator.nextSequence();
      return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : undefined;
    } catch { return undefined; }
  }
  /** Lifecycle requests use two bounded attempts. */
  private async send(method: HerdrMethod, params: Record<string,unknown>, key:string, priority=false, retry=true, cleanup=false): Promise<void> {
    if(this.closed||(this.closing&&!cleanup))return;
    const revision=(this.keyRevisions.get(key)??0)+1;
    this.keyRevisions.set(key,revision);
    const id=`${LIFECYCLE_SOURCE}:${++this.requestNumber}`;
    try {
      let line: string;
      // Validation and serialization are output-only too: never dispatch or reject lifecycle work.
      try { line=encodeHerdrRequest({id,method,params}); } catch { return; }
      const firstTimeout=Math.floor(this.config.timeoutMs/2);
      const retryTimeout=this.config.timeoutMs-firstTimeout;
      try { const response=await this.transport.request(line,key,priority,firstTimeout); decodeHerdrResponse(response,id); }
      catch (error) {
        // Transport does not distinguish pre-dispatch failures from timeout/EOF.
        if(!retry || this.closed || this.closing || this.keyRevisions.get(key)!==revision || (error instanceof PresenceTransportError && /^Socket queue (coalesced|displaced|closed|is full)/.test(error.message)))return;
        try { decodeHerdrResponse(await this.transport.request(line,key,priority,retryTimeout),id); } catch { /* output-only best effort */ }
      }
    } finally {
      // A completed current revision cannot supersede future work, so retaining
      // it only grows this per-session coalescing fence.
      if(this.keyRevisions.get(key)===revision)this.keyRevisions.delete(key);
    }
  }
}

function safeSessionStartReason(reason: unknown): reason is string { return typeof reason==="string" && reason.length>0 && Buffer.byteLength(reason,"utf8")<=512 && !hasControlOrBidi(reason); }
