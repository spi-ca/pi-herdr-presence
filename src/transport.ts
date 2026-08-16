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
interface Pending { key?:string; work:(s:AbortSignal)=>Promise<string>; promise:Promise<string>; resolve:(v:string)=>void; reject:(e:unknown)=>void; }
/** A bounded latest-write-wins queue. Superseded callers settle immediately. */
export class BoundedSocketQueue {
 private queue:Pending[]=[]; private keyed=new Map<string,Pending>(); private active:AbortController|null=null; private closed=false; private drainPromise:Promise<void>|null=null;
 constructor(private readonly limit:number){}
 enqueue(work:(s:AbortSignal)=>Promise<string>,key?:string,priority=false):Promise<string>{
  if(this.closed)return Promise.reject(new PresenceTransportError("Socket queue is closed."));
  const prior=key?this.keyed.get(key):undefined;
  if(prior){const index=this.queue.indexOf(prior);if(index>=0)this.queue.splice(index,1);this.keyed.delete(key!);prior.reject(new PresenceTransportError("Socket queue coalesced by newer request."));}
  if(priority){for(const displaced of this.queue.splice(0)){if(displaced.key)this.keyed.delete(displaced.key);displaced.reject(new PresenceTransportError("Socket queue displaced by priority release."));}}
  else if(this.queue.length>=this.limit)return Promise.reject(new PresenceTransportError("Socket queue is full."));
  let resolve!:Pending["resolve"],reject!:Pending["reject"];const promise=new Promise<string>((r,j)=>{resolve=r;reject=j});const item={key,work,promise,resolve,reject};if(priority)this.queue.unshift(item);else this.queue.push(item);if(key)this.keyed.set(key,item);this.start();return promise;
 }
 private start(){if(!this.drainPromise)this.drainPromise=this.drain().finally(()=>{this.drainPromise=null;if(this.queue.length&&!this.closed)this.start();});}
 private async drain(){while(!this.closed&&this.queue.length){const item=this.queue.shift()!;if(item.key)this.keyed.delete(item.key);const control=new AbortController;this.active=control;try{item.resolve(await item.work(control.signal));}catch(e){item.reject(e);}finally{if(this.active===control)this.active=null;}}}
 async close(timeoutMs=0){
  if(this.closed)return;this.closed=true;this.active?.abort();
  for(const item of this.queue.splice(0))item.reject(new PresenceTransportError("Socket queue closed before dispatch."));
  this.keyed.clear();
  const draining=this.drainPromise??Promise.resolve();
  if(timeoutMs<=0){await draining;return;}
  let timer:ReturnType<typeof setTimeout>|undefined;
  await Promise.race([draining,new Promise<void>(resolve=>{timer=setTimeout(resolve,timeoutMs);timer.unref?.();})]);
  if(timer)clearTimeout(timer);
 }
}
export class HerdrSocketTransport { private queue:BoundedSocketQueue; constructor(private endpoint:string,private timeoutMs:number,maxQueue:number){this.queue=new BoundedSocketQueue(maxQueue)} request(line:string,key?:string,priority=false,timeoutMs=this.timeoutMs){return this.queue.enqueue(s=>exchange(this.endpoint,line,timeoutMs,s),key,priority)} close(timeoutMs=this.timeoutMs){return this.queue.close(timeoutMs)} }
