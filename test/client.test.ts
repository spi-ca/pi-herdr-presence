import { expect, test } from "bun:test";
import { PresenceClient } from "../src/client.js";
import { resolvePresenceConfig } from "../src/config.js";
import { BoundedSocketQueue } from "../src/transport.js";

test("client uses one lifecycle authority, path session refs, and schema clears", async () => {
 const requests:Array<{method:string;params:Record<string,unknown>;priority:boolean}>=[];
 const transport={async request(line:string,_key?:string,priority=false){const request=JSON.parse(line);requests.push({method:request.method,params:request.params,priority});return JSON.stringify({id:request.id,result:{}});},async close(){}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,resolvePresenceConfig());
 const ref={agent_session_path:"/sessions/root.jsonl"} as const;
 await client.reportSession(ref); await client.report("working",ref,"Pi is working"); await client.metadata({title:"Pi",displayAgent:"Pi",labels:{idle:"Idle"},tokens:{active:"1"}}); await client.clearMetadata(); await client.release();
 expect(requests[0]).toMatchObject({method:"pane.report_agent_session",params:{source:"herdr:pi",agent_session_path:ref.agent_session_path}});
 expect(requests[1]).toMatchObject({method:"pane.report_agent",params:{source:"herdr:pi",agent_session_path:ref.agent_session_path}});
 expect(requests[2]).toMatchObject({method:"pane.report_metadata",params:{source:"herdr:pi",applies_to_source:"herdr:pi"}});
 expect(requests[3]?.params).toMatchObject({clear_title:true,clear_display_agent:true,clear_state_labels:true,tokens:{context:null}});
 expect(requests[4]).toMatchObject({method:"pane.release_agent",priority:true,params:{source:"herdr:pi"}});
});

test("invalid output is contained without transport dispatch, while an invalid session reason is omitted", async () => {
 const requests:Array<Record<string,unknown>>=[];
 const transport={async request(line:string){const request=JSON.parse(line);requests.push(request);return JSON.stringify({id:request.id,result:{}});},async close(){}};
 const invalid=new PresenceClient({paneId:"😀".repeat(65),socketPath:"/socket"},transport as never,resolvePresenceConfig());
 await expect(invalid.report("working",{agent_session_id:"root"})).resolves.toBeUndefined();
 await expect(invalid.reportSession({agent_session_id:"root"})).resolves.toBeUndefined();
 expect(requests).toHaveLength(0);
 const stringify=JSON.stringify;
 try { JSON.stringify=()=>{throw new Error("serialization failure");}; await expect(new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,resolvePresenceConfig()).report("working",{agent_session_id:"root"})).resolves.toBeUndefined(); } finally { JSON.stringify=stringify; }
 expect(requests).toHaveLength(0);
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,resolvePresenceConfig());
 await expect(client.reportSession({agent_session_id:"root"},"😀".repeat(129))).resolves.toBeUndefined();
 expect(requests).toHaveLength(1);
 expect(requests[0]?.params).not.toHaveProperty("session_start_source");
});

test("configured timeout is split across the two connection/response attempts", async () => {
 const timeouts:number[]=[];
 const transport={async request(line:string,_key?:string,_priority=false,timeoutMs?:number){const request=JSON.parse(line);timeouts.push(timeoutMs!);return timeouts.length===1?"invalid":JSON.stringify({id:request.id,result:{type:"ok"}});},async close(){}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,{...resolvePresenceConfig(),timeoutMs:701});
 await client.report("working",{agent_session_id:"root"});
 expect(timeouts).toEqual([350,351]);
});

test("notification.show uses one attempt after an unknown transport outcome", async () => {
 const attempts:number[]=[];
 const transport={async request(_line:string,_key?:string,_priority=false,timeoutMs?:number){attempts.push(timeoutMs!);throw new Error("socket timed out after dispatch");},async close(){}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,{...resolvePresenceConfig(),timeoutMs:701});
 await client.notify("Pi needs attention","A safe static body",true);
 expect(attempts).toEqual([350]);
});

test("teardown clears metadata before priority release and then closes", async () => {
 const requests:string[]=[];const closes:number[]=[];
 const transport={async request(line:string){requests.push(JSON.parse(line).method);const request=JSON.parse(line);return JSON.stringify({id:request.id,result:{}});},async close(timeoutMs?:number){closes.push(timeoutMs??-1);}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,{...resolvePresenceConfig(),timeoutMs:100});
 await client.teardown();
 expect(requests).toEqual(["pane.report_metadata","pane.release_agent"]);
 expect(closes).toHaveLength(1);
 expect(closes[0]).toBeGreaterThanOrEqual(0);
 expect(closes[0]).toBeLessThanOrEqual(100);
});

test("teardown expiry aborts within its aggregate budget and never dispatches release", async () => {
 const requests:string[]=[];const closes:number[]=[];
 const transport={request(line:string){requests.push(JSON.parse(line).method);return new Promise<string>(()=>{});},async close(timeoutMs?:number){closes.push(timeoutMs??-1);}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,{...resolvePresenceConfig(),timeoutMs:25});
 const completed=client.teardown();
 await expect(Promise.race([completed.then(()=>"closed"),new Promise<string>(resolve=>setTimeout(()=>resolve("timed out"),100))])).resolves.toBe("closed");
 expect(requests).toEqual(["pane.report_metadata"]);
 expect(closes).toEqual([0]);
});

test("teardown fences an active lifecycle failure before cleanup so no stale retry can follow clear", async () => {
 const queue=new BoundedSocketQueue(4);const requests:string[]=[];let releaseActive!:()=>void;let activeStarted!:()=>void;
 const activeGate=new Promise<void>(resolve=>{releaseActive=resolve;});const started=new Promise<void>(resolve=>{activeStarted=resolve;});
 const transport={request(line:string,key?:string,priority=false){const request=JSON.parse(line);return queue.enqueue(async()=>{requests.push(request.method);if(request.method==="pane.report_agent"){activeStarted();await activeGate;throw new Error("active report failed");}return JSON.stringify({id:request.id,result:{}});},key,priority);},async close(timeoutMs?:number){await queue.close(timeoutMs);}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,{...resolvePresenceConfig(),timeoutMs:100});
 const report=client.report("working",{agent_session_id:"root"});await started;const teardown=client.teardown();releaseActive();await Promise.all([report,teardown]);
 expect(requests).toEqual(["pane.report_agent","pane.report_metadata","pane.release_agent"]);
});

test("a failed stale keyed attempt does not retry over the latest agent state", async () => {
 const queue=new BoundedSocketQueue(4);
 const ref={agent_session_id:"root"} as const;
 const dispatched:string[]=[];
 let releaseOld!:()=>void,releaseSession!:()=>void,oldStarted!:()=>void,sessionActive!:()=>void;
 const oldGate=new Promise<void>(resolve=>{releaseOld=resolve;});
 const sessionGate=new Promise<void>(resolve=>{releaseSession=resolve;});
 const oldStartedPromise=new Promise<void>(resolve=>{oldStarted=resolve;});
 const sessionActivePromise=new Promise<void>(resolve=>{sessionActive=resolve;});
 let latest:Promise<void>|undefined;
 let client!:PresenceClient;
 const transport={request(line:string,key?:string,priority=false){
  const request=JSON.parse(line);
  return queue.enqueue(async()=>{
   dispatched.push(`${request.method}:${request.params.state??""}`);
   if(request.method==="pane.report_agent"&&request.params.state==="working"){oldStarted();await oldGate;throw new Error("first attempt failed");}
   if(request.method==="pane.report_agent_session"){latest=client.report("idle",ref);sessionActive();await sessionGate;}
   return JSON.stringify({id:request.id,result:{type:"ok"}});
  },key,priority);
 },async close(){await queue.close();}};
 client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,resolvePresenceConfig());
 const stale=client.report("working",ref);
 await oldStartedPromise;
 const otherActive=client.reportSession(ref);
 releaseOld();
 await sessionActivePromise;
 await Promise.resolve();
 expect(dispatched.filter(entry=>entry.startsWith("pane.report_agent:"))).toEqual(["pane.report_agent:working"]);
 releaseSession();
 await Promise.all([stale,otherActive,latest!]);
 expect(dispatched.filter(entry=>entry.startsWith("pane.report_agent:"))).toEqual(["pane.report_agent:working","pane.report_agent:idle"]);
 await queue.close();
});
