import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const OFFICIAL_HOOK_MARKER = "cmux-pi-session-extension-marker v2";

export function expandHomeDirectory(value: string, homeDirectory = os.homedir()): string {
  if (value === "~") return homeDirectory;
  if (value.startsWith("~/")) return path.join(homeDirectory, value.slice(2));
  return value;
}

export async function officialHookDetected(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.CMUX_PI_HOOKS_DISABLED === "1") return false;

  const homeDirectory = env.HOME?.trim() || os.homedir();
  const configuredAgentDirectory = env.PI_CODING_AGENT_DIR?.trim();
  const agentDirectory = configuredAgentDirectory
    ? expandHomeDirectory(configuredAgentDirectory, homeDirectory)
    : path.join(homeDirectory, ".pi", "agent");
  const hookPath = path.join(agentDirectory, "extensions", "cmux-session.ts");

  try {
    const source = await fs.readFile(hookPath, "utf8");
    return source.includes(OFFICIAL_HOOK_MARKER);
  } catch {
    return false;
  }
}
