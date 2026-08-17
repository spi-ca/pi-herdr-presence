import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { PresenceRuntime } from "../src/runtime.js";
import { resolvePresenceConfig } from "../src/config.js";
import { PI_PRESENCE_READY_EVENT } from "../src/events.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const subagent = (sequence: number, state: "running" | "success" | "error" | "cancelled", counts: { active: number; completed: number; failed: number; cancelled?: number }, attention: "none" | "success" | "error" = "none") => ({ version: 1 as const, sessionId: "session", generation: 1, sequence, source: { id: "pi-subagent", label: "private agent task", kind: "aggregate" }, state, counts, attention });
async function withRuntime(policy: "errors" | "background" | "all", run: (runtime: PresenceRuntime, lines: string[]) => Promise<void>) { const dir=await fs.mkdtemp(join(os.tmpdir(),"herdr-runtime-"));const socket=join(dir,"socket");const lines:string[]=[];const server=await fakeSocket(socket,line=>{lines.push(line);return JSON.stringify({id:JSON.parse(line).id,result:{}});});const keys=["HERDR_ENV","HERDR_SOCKET_PATH","HERDR_PANE_ID","PI_CODING_AGENT_DIR"] as const;const saved=Object.fromEntries(keys.map(key=>[key,process.env[key]]));try{Object.assign(process.env,{HERDR_ENV:"1",HERDR_SOCKET_PATH:socket,HERDR_PANE_ID:"pane",PI_CODING_AGENT_DIR:join(dir,"missing")});const runtime=new PresenceRuntime({getAllTools(){return[]},events:{emit(){}}} as never,{...resolvePresenceConfig(),notificationPolicy:policy});await runtime.startSession({mode:"tui",sessionManager:{getSessionId:()=>"session"}});await run(runtime,lines);await runtime.shutdownSession();}finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await server.close();await fs.rm(dir,{recursive:true,force:true});}}
const notices = (lines: string[]) => lines.map((line) => JSON.parse(line)).filter((request) => request.method === "notification.show");

test("ready identities prevent self-recursion and subagent coalescing keeps its first deadline", async () => {
 const dir=await fs.mkdtemp(join(os.tmpdir(),"herdr-runtime-")); const socket=join(dir,"socket"); const lines:string[]=[];
 const server=await fakeSocket(socket,line=>{lines.push(line);return JSON.stringify({id:JSON.parse(line).id,result:{type:"ok"}});});
 const saved={HERDR_ENV:process.env.HERDR_ENV,HERDR_SOCKET_PATH:process.env.HERDR_SOCKET_PATH,HERDR_PANE_ID:process.env.HERDR_PANE_ID,PI_CODING_AGENT_DIR:process.env.PI_CODING_AGENT_DIR};
 try {
  Object.assign(process.env,{HERDR_ENV:"1",HERDR_SOCKET_PATH:socket,HERDR_PANE_ID:"pane",PI_CODING_AGENT_DIR:join(dir,"missing")});
  const listeners=new Map<string,Array<(payload:unknown)=>void>>(); let advertisements=0; let capabilities:string[]=[];
  const pi={getAllTools(){return[]},events:{on(name:string,handler:(payload:unknown)=>void){const list=listeners.get(name)??[];list.push(handler);listeners.set(name,list)},emit(name:string,payload:unknown){const consumer=(payload as {consumer?:{capabilities?:string[]}}).consumer;if(name===PI_PRESENCE_READY_EVENT&&consumer){advertisements++;capabilities=consumer.capabilities??[];}for(const handler of listeners.get(name)??[])handler(payload)}}};
  const runtime=new PresenceRuntime(pi as never,{...resolvePresenceConfig(),notificationPolicy:"all"});
  pi.events.on(PI_PRESENCE_READY_EVENT,payload=>runtime.handleReady(payload));
  await runtime.startSession({mode:"tui",sessionManager:{getSessionId:()=>"session"}});
  expect(advertisements).toBe(1);
  // Summary is announced as a passive capability, never an authority grant.
  expect(capabilities).toContain("presence-summary-v1");
  pi.events.emit(PI_PRESENCE_READY_EVENT,{version:1,sessionId:"session"});
  expect(advertisements).toBe(2);
  const source={id:"pi-subagent",label:"Subagents",kind:"aggregate"};
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:1,source,state:"running",counts:{active:1,completed:0,failed:0},attention:"none"});
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:2,source,state:"success",counts:{active:0,completed:1,failed:0},attention:"success"});
  await new Promise(resolve=>setTimeout(resolve,300));
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:3,source,state:"success",counts:{active:0,completed:2,failed:0},attention:"success"});
  await new Promise(resolve=>setTimeout(resolve,220));
  expect(lines.map(line=>JSON.parse(line).method).filter(method=>method==="notification.show")).toHaveLength(1);
  // A later terminal burst has a new sequence/category identity and must not be
  // suppressed by the dedupe TTL of the first aggregate.
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:4,source,state:"running",counts:{active:1,completed:2,failed:0},attention:"none"});
  runtime.handlePresenceUpdate({version:1,sessionId:"session",generation:1,sequence:5,source,state:"error",counts:{active:0,completed:2,failed:1},attention:"error"});
  await new Promise(resolve=>setTimeout(resolve,150));
  expect(lines.map(line=>JSON.parse(line).method).filter(method=>method==="notification.show")).toHaveLength(2);
  await runtime.shutdownSession();
 } finally { for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;} await server.close();await fs.rm(dir,{recursive:true,force:true}); }
});

test("subagent terminal notices use bounded unknown, count, mixed, and cancellation wording", async () => {
 await withRuntime("background", async (runtime, lines) => {
  runtime.handlePresenceUpdate(subagent(1,"success",{active:0,completed:2,failed:0},"success"));
  await pause(500);
  runtime.handlePresenceUpdate(subagent(2,"running",{active:1,completed:2,failed:0}));
  runtime.handlePresenceUpdate(subagent(3,"success",{active:0,completed:4,failed:0},"success"));
  await pause(500);
  runtime.handlePresenceUpdate(subagent(4,"running",{active:1,completed:4,failed:0}));
  runtime.handlePresenceUpdate(subagent(5,"success",{active:0,completed:5,failed:0},"success"));
  runtime.handlePresenceUpdate(subagent(6,"error",{active:0,completed:5,failed:2},"error"));
  await pause(150);
  runtime.handlePresenceUpdate(subagent(7,"cancelled",{active:0,completed:5,failed:2,cancelled:1}));
  await pause(150);
  expect(notices(lines).map((request) => request.params.title)).toEqual(["Subagents finished","2 subagents finished","1 subagent finished; 2 failed"]);
  expect(JSON.stringify(lines)).not.toContain("private agent task");
 });
});

test("active parent suppresses subagent success but reports failures promptly", async () => {
 await withRuntime("background", async (runtime, lines) => {
  runtime.handleAgentStart();
  runtime.handlePresenceUpdate(subagent(1,"running",{active:1,completed:0,failed:0}));
  runtime.handlePresenceUpdate(subagent(2,"success",{active:0,completed:1,failed:0},"success"));
  await pause(500);
  expect(notices(lines)).toHaveLength(0);
  runtime.handleAgentSettled({isIdle:()=>true});
  await pause(50);
  expect(notices(lines)).toHaveLength(0);
 });
 await withRuntime("errors", async (runtime, lines) => {
  runtime.handleAgentStart();
  runtime.handlePresenceUpdate(subagent(1,"running",{active:1,completed:0,failed:0}));
  runtime.handlePresenceUpdate(subagent(2,"error",{active:0,completed:0,failed:1},"error"));
  await pause(150);
  expect(notices(lines)).toHaveLength(1);
  expect(notices(lines)[0].params).toMatchObject({title:"1 subagent failed",sound:"request"});
 });
});
