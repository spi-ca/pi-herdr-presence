import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { hasControlOrBidi } from "./validation.js";

const MARKER = "HERDR_INTEGRATION_ID=pi";
/** `unknown` means the managed integration cannot be safely ruled out. */
export type OfficialHookStatus = "present" | "absent" | "unknown";

/**
 * Pi uses a non-empty PI_CODING_AGENT_DIR verbatim except for exact `~`/`~/`
 * expansion. This fail-closed mirror rejects values whose path meaning could
 * differ from that rule instead of trimming or normalizing them ourselves.
 */
function exactPath(value: string): string | undefined {
  if (value.length === 0 || value.trim() !== value || hasControlOrBidi(value)) return undefined;
  return value;
}
function safeAbsolute(value: string): string | undefined {
  return path.isAbsolute(value) && path.normalize(value) === value ? value : undefined;
}
function officialHookBase(env: NodeJS.ProcessEnv): string | undefined {
  const rawConfigured = env.PI_CODING_AGENT_DIR;
  const rawHome = env.HOME;
  // HOME is only needed for Pi's exact tilde expansion/default. Do not turn a
  // whitespace-padded value into a different directory by calling trim().
  const home = rawHome === undefined || rawHome === "" ? os.homedir() : exactPath(rawHome);
  if (!home || !safeAbsolute(home)) return undefined;
  if (rawConfigured === undefined || rawConfigured === "") return safeAbsolute(path.join(home, ".pi", "agent"));
  const configured = exactPath(rawConfigured);
  if (!configured) return undefined;
  if (configured === "~") return home;
  // Preserve lexical components for safeAbsolute instead of normalizing `..`
  // through path.join before validation.
  if (configured.startsWith("~/")) return safeAbsolute(`${home}${path.sep}${configured.slice(2)}`);
  // Pi can technically retain a relative override, but this observer cannot
  // prove the same runtime cwd at this later hook probe. Treat it as ambiguous.
  return safeAbsolute(configured);
}

/**
 * Detect the Herdr-managed Pi extension without executing it. Read failures are
 * deliberately unknown, not absence: claiming a competing authority is unsafe.
 */
export async function officialHookStatus(env: NodeJS.ProcessEnv = process.env): Promise<OfficialHookStatus> {
  const base = officialHookBase(env);
  if (!base) return "unknown";

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
