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

test("configured timeout is split across the two connection/response attempts", async () => {
 const timeouts:number[]=[];
 const transport={async request(line:string,_key?:string,_priority=false,timeoutMs?:number){const request=JSON.parse(line);timeouts.push(timeoutMs!);return timeouts.length===1?"invalid":JSON.stringify({id:request.id,result:{type:"ok"}});},async close(){}};
 const client=new PresenceClient({paneId:"pane",socketPath:"/socket"},transport as never,{...resolvePresenceConfig(),timeoutMs:701});
 await client.report("working",{agent_session_id:"root"});
 expect(timeouts).toEqual([350,351]);
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
