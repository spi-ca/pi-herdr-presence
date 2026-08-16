import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const MARKER = "HERDR_INTEGRATION_ID=pi";
/** `unknown` means the managed integration cannot be safely ruled out. */
export type OfficialHookStatus = "present" | "absent" | "unknown";

/**
 * Detect the Herdr-managed Pi extension without executing it. Read failures are
 * deliberately unknown, not absence: claiming a competing authority is unsafe.
 */
export async function officialHookStatus(env: NodeJS.ProcessEnv = process.env): Promise<OfficialHookStatus> {
  const home = env.HOME?.trim() || os.homedir();
  const base = env.PI_CODING_AGENT_DIR?.trim() || path.join(home, ".pi", "agent");
  try {
    const source = await fs.readFile(path.join(base, "extensions", "herdr-agent-state.ts"), "utf8");
    // A managed asset without the expected marker is not safe evidence of absence.
    return source.includes(MARKER) ? "present" : "unknown";
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? "absent" : "unknown";
  }
}

/** Compatibility helper; unknown is fail-closed just like a managed integration. */
export async function officialHookDetected(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await officialHookStatus(env)) !== "absent";
}
