import {expect,test} from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {join} from "node:path";
import {officialHookDetected,officialHookStatus} from "../src/official-hook.js";

test("only an absent managed file permits the local integration",async()=>{
  const root=await fs.mkdtemp(join(os.tmpdir(),"herdr-managed-"));
  try{
    await fs.mkdir(join(root,"extensions"));
    const managed=join(root,"extensions","herdr-agent-state.ts");
    await fs.writeFile(managed,"// HERDR_INTEGRATION_ID=pi\n");
    expect(await officialHookStatus({PI_CODING_AGENT_DIR:root})).toBe("present");
    expect(await officialHookDetected({PI_CODING_AGENT_DIR:root})).toBe(true);
    await fs.writeFile(managed,"// managed asset without the expected marker\n");
    expect(await officialHookStatus({PI_CODING_AGENT_DIR:root})).toBe("unknown");
    expect(await officialHookDetected({PI_CODING_AGENT_DIR:root})).toBe(true);
    expect(await officialHookStatus({PI_CODING_AGENT_DIR:join(root,"missing")})).toBe("absent");
    await fs.rm(managed);
    expect(await officialHookStatus({PI_CODING_AGENT_DIR:root})).toBe("absent");
    await fs.mkdir(managed);
    expect(await officialHookStatus({PI_CODING_AGENT_DIR:root})).toBe("unknown");
    expect(await officialHookDetected({PI_CODING_AGENT_DIR:root})).toBe(true);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test("expands exact home-relative configured paths",async()=>{
  const home=await fs.mkdtemp(join(os.tmpdir(),"herdr-home-"));
  try{
    await fs.mkdir(join(home,"extensions"));
    await fs.writeFile(join(home,"extensions","herdr-agent-state.ts"),"HERDR_INTEGRATION_ID=pi");
    const agent=join(home,"managed-agent");
    await fs.mkdir(join(agent,"extensions"),{recursive:true});
    await fs.writeFile(join(agent,"extensions","herdr-agent-state.ts"),"HERDR_INTEGRATION_ID=pi");
    expect(await officialHookStatus({HOME:home,PI_CODING_AGENT_DIR:"~"})).toBe("present");
    expect(await officialHookStatus({HOME:home,PI_CODING_AGENT_DIR:"~/managed-agent"})).toBe("present");
    expect(await officialHookStatus({HOME:home,PI_CODING_AGENT_DIR:"~/absent-agent"})).toBe("absent");
  }finally{await fs.rm(home,{recursive:true,force:true});}
});

test("fails closed for unsafe configured paths",async()=>{
  const absolute=join(os.tmpdir(),"herdr-agent");
  for(const configured of ["relative-agent","./relative-agent","~other","~other/agent","~/../agent",`${absolute}\u0000`,`${absolute}\u202e`,` ${absolute}`,`${absolute} `,`${absolute}/../agent`]){
    expect(await officialHookStatus({PI_CODING_AGENT_DIR:configured})).toBe("unknown");
    expect(await officialHookDetected({PI_CODING_AGENT_DIR:configured})).toBe(true);
  }
  expect(await officialHookStatus({HOME:` ${os.homedir()}`,PI_CODING_AGENT_DIR:"~"})).toBe("unknown");
  expect(await officialHookStatus({HOME:`${os.homedir()} `,PI_CODING_AGENT_DIR:"~"})).toBe("unknown");
});
