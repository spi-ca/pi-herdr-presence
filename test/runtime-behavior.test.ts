import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { PresenceRuntime } from "../src/runtime.js";
import { resolvePresenceConfig } from "../src/config.js";
import { PI_PRESENCE_READY_EVENT } from "../src/events.js";
import { fakeSocket } from "./helpers/fake-socket.js";

test("ready identities prevent self-recursion and subagent coalescing keeps its first deadline", async () => {
 const dir=await fs.mkdtemp(join(os.tmpdir(),"herdr-runtime-")); const socket=join(dir,"socket"); const lines:string[]=[];
 const server=await fakeSocket(socket,line=>{lines.push(line);return JSON.stringify({id:JSON.parse(line).id,result:{type:"ok"}});});
 const saved={HERDR_ENV:process.env.HERDR_ENV,HERDR_SOCKET_PATH:process.env.HERDR_SOCKET_PATH,HERDR_PANE_ID:process.env.HERDR_PANE_ID,PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR};
 try {
  Object.assign(process.env,{HERDR_ENV:"1",HERDR_SOCKET_PATH:socket,HERDR_PANE_ID:"pane",PI_CODING_AGENT_DIR:join(dir,"missing")});
  const listeners=new Map<string,Array<(payload:unknown)=>void>>(); let advertisements=0;
  const pi={getAllTools(){return[]},events:{on(name:string,handler:(payload:unknown)=>void){const list=listeners.get(name)??[];list.push(handler);listeners.set(name,list)},emit(name:string,payload:unknown){if(name===PI_PRESENCE_READY_EVENT&&(payload as {consumer?:unknown}).consumer)advertisements++;for(const handler of listeners.get(name)??[])handler(payload)}}};
  const runtime=new PresenceRuntime(pi as never,{...resolvePresenceConfig(),notificationPolicy:"all"});
  pi.events.on(PI_PRESENCE_READY_EVENT,payload=>runtime.handleReady(payload));
  await runtime.startSession({mode:"tui",sessionManager:{getSessionId:()=>"session"}});
  expect(advertisements).toBe(1);
  pi.events.emit(PI_PRESENCE_READY_EVENT,{version:1,sessionId:"session"});
  expect(advertisements).toBe(2);
  const source={id:"pi-subagent",label:"Subagents",kind:"aggregate"};
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:1,source,state:"running",counts:{active:1,completed:0,failed:0},attention:"none"});
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:2,source,state:"success",counts:{active:0,completed:1,failed:0},attention:"success"});
  await new Promise(resolve=>setTimeout(resolve,300));
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:3,source,state:"success",counts:{active:0,completed:2,failed:0},attention:"success"});
  await new Promise(resolve=>setTimeout(resolve,220));
  expect(lines.map(line=>JSON.parse(line).method).filter(method=>method==="notification.show")).toHaveLength(1);
  await runtime.shutdownSession();
 } finally { for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;} await server.close();await fs.rm(dir,{recursive:true,force:true}); }
});
