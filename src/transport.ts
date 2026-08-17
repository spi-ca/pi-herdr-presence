import net from "node:net";
import { safeSocketFingerprint, type SocketFingerprint } from "./identity.js";
export class PresenceTransportError extends Error {}
const same = (a: SocketFingerprint,b: SocketFingerprint) => a.dev===b.dev && a.ino===b.ino && a.uid===b.uid;

async function exchange(endpoint: string, line: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
 if(signal?.aborted) throw new PresenceTransportError("Socket request aborted.");
 const before=await safeSocketFingerprint(endpoint);
 if(signal?.aborted) throw new PresenceTransportError("Socket request aborted.");
 return await new Promise((resolve,reject)=>{
  let buffer="",done=false;
  const socket=net.createConnection({path:endpoint});
  let timer:ReturnType<typeof setTimeout>|undefined;
  const finish=(error?:Error,value?:string)=>{if(done)return;done=true;if(timer)clearTimeout(timer);signal?.removeEventListener("abort",abort);socket.destroy();error?reject(error):resolve(value??"");};
  const abort=()=>finish(new PresenceTransportError("Socket request aborted."));
  timer=setTimeout(()=>finish(new PresenceTransportError("Socket request timed out.")),timeoutMs);timer.unref?.();
  signal?.addEventListener("abort",abort,{once:true});
  socket.setEncoding("utf8");socket.once("error",e=>finish(new PresenceTransportError(`Socket failure: ${e.message}`)));socket.once("end",()=>finish(new PresenceTransportError("Socket closed before a complete response.")));socket.once("close",()=>finish(new PresenceTransportError("Socket closed before a complete response.")));
  socket.on("data",(chunk:string)=>{buffer+=chunk;if(Buffer.byteLength(buffer,"utf8")>16*1024+1)return finish(new PresenceTransportError("Socket response exceeds bound."));const n=buffer.indexOf("\n");if(n<0)return;if(buffer.length!==n+1)return finish(new PresenceTransportError("Socket sent more than one response line."));finish(undefined,buffer.slice(0,n));});
  socket.once("connect",async()=>{try{if(done||signal?.aborted)return abort();const after=await safeSocketFingerprint(endpoint);if(done||signal?.aborted)return abort();if(!same(before,after))return finish(new PresenceTransportError("Socket changed during connection."));socket.write(line,e=>{if(e)finish(new PresenceTransportError(`Socket write failed: ${e.message}`));});}catch(e){finish(e instanceof Error?e:new PresenceTransportError("Socket validation failed."));}});
 });
}
interface Pending { key?:string; work:(s:AbortSignal)=>Promise<string>; promise:Promise<string>; resolve:(v:string)=>void; reject:(e:unknown)=>void; settled:boolean; }
type Active = { control:AbortController; item:Pending };
/** A bounded latest-write-wins queue. Superseded callers settle immediately. */
export class BoundedSocketQueue {
 private queue:Pending[]=[]; private keyed=new Map<string,Pending>(); private active:Active|null=null; private closed=false; private drainPromise:Promise<void>|null=null;
 constructor(private readonly limit:number){}
 private resolve(item:Pending,value:string){if(item.settled)return;item.settled=true;item.resolve(value);}
 private reject(item:Pending,error:unknown){if(item.settled)return;item.settled=true;item.reject(error);}
 private failed(error:Error):Promise<string>{const promise=Promise.reject<string>(error);void promise.catch(()=>{});return promise;}
 enqueue(work:(s:AbortSignal)=>Promise<string>,key?:string,priority=false):Promise<string>{
  if(this.closed)return this.failed(new PresenceTransportError("Socket queue is closed."));
  const prior=key?this.keyed.get(key):undefined;
  if(prior){const index=this.queue.indexOf(prior);if(index>=0)this.queue.splice(index,1);this.keyed.delete(key!);this.reject(prior,new PresenceTransportError("Socket queue coalesced by newer request."));}
  if(priority){for(const displaced of this.queue.splice(0)){if(displaced.key)this.keyed.delete(displaced.key);this.reject(displaced,new PresenceTransportError("Socket queue displaced by priority release."));}}
  else if(this.queue.length>=this.limit)return this.failed(new PresenceTransportError("Socket queue is full."));
  let resolve!:Pending["resolve"],reject!:Pending["reject"];const promise=new Promise<string>((r,j)=>{resolve=r;reject=j});void promise.catch(()=>{});const item:Pending={key,work,promise,resolve,reject,settled:false};if(priority)this.queue.unshift(item);else this.queue.push(item);if(key)this.keyed.set(key,item);this.start();return promise;
 }
 private start(){if(!this.drainPromise)this.drainPromise=this.drain().finally(()=>{this.drainPromise=null;if(this.queue.length&&!this.closed)this.start();});}
 private async drain(){while(!this.closed&&this.queue.length){const item=this.queue.shift()!;if(item.key)this.keyed.delete(item.key);const active={control:new AbortController,item};this.active=active;try{this.resolve(item,await item.work(active.control.signal));}catch(e){this.reject(item,e);}finally{if(this.active===active)this.active=null;}}}
 async close(timeoutMs=0){
  if(this.closed)return;this.closed=true;
  const active=this.active;if(active){active.control.abort();this.reject(active.item,new PresenceTransportError("Socket queue closed during active work."));if(this.active===active)this.active=null;}
  for(const item of this.queue.splice(0))this.reject(item,new PresenceTransportError("Socket queue closed before dispatch."));
  this.keyed.clear();
  // An abort-unaware work function may never settle. Immediate close is therefore
  // fire-and-forget; drain still consumes its eventual outcome without dispatching.
  if(timeoutMs<=0)return;
  const draining=this.drainPromise??Promise.resolve();
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([draining,new Promise<void>(resolve=>{timer=setTimeout(resolve,timeoutMs);timer.unref?.();})]);
  if(timer)clearTimeout(timer);
 }
}
export class HerdrSocketTransport { private queue:BoundedSocketQueue; constructor(private endpoint:string,private timeoutMs:number,maxQueue:number){this.queue=new BoundedSocketQueue(maxQueue)} request(line:string,key?:string,priority=false,timeoutMs=this.timeoutMs){return this.queue.enqueue(s=>exchange(this.endpoint,line,timeoutMs,s),key,priority)} close(timeoutMs=this.timeoutMs){return this.queue.close(timeoutMs)} }
