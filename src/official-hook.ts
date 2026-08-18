import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { processCoordinator } from "./process-coordinator.js";
import { hasControlOrBidi } from "./validation.js";

const MARKER = "HERDR_INTEGRATION_ID=pi";
/** The managed hook is source, never an unbounded input channel. */
export const OFFICIAL_HOOK_MAX_BYTES = 64 * 1024;
/** A stalled filesystem probe must never delay lifecycle ownership indefinitely. */
export const OFFICIAL_HOOK_PROBE_DEADLINE_MS = 250;
/** `unknown` means the managed integration cannot be safely ruled out. */
export type OfficialHookStatus = "present" | "absent" | "unknown";
type FileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number; isFile(): boolean };

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

function isExactAbsent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}
function requireRegularBoundedFile(entry: FileIdentity): void {
  if (!entry.isFile()) throw new Error("Official hook is not a regular file.");
  if (entry.size > OFFICIAL_HOOK_MAX_BYTES) throw new Error("Official hook exceeds the conservative read limit.");
}
function sameStableFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.isFile() && right.isFile()
    && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
/** Read one validated descriptor using a fixed max+1 buffer. */
async function readBounded(handle: Awaited<ReturnType<typeof fs.open>>): Promise<string> {
  const buffer = Buffer.alloc(OFFICIAL_HOOK_MAX_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > OFFICIAL_HOOK_MAX_BYTES) throw new Error("Official hook exceeds the conservative read limit.");
  return buffer.subarray(0, offset).toString("utf8");
}

/**
 * Detect the Herdr-managed Pi extension without executing it. The leaf is
 * lstat/opened without following links, descriptor-validated, bounded, and
 * revalidated after reading. Only an initial exact ENOENT proves absence.
 */
async function probeOfficialHook(base: string): Promise<OfficialHookStatus> {

  const hookPath = path.join(base, "extensions", "herdr-agent-state.ts");
  let initial: FileIdentity;
  try {
    initial = await fs.lstat(hookPath);
  } catch (error) {
    return isExactAbsent(error) ? "absent" : "unknown";
  }

  try {
    requireRegularBoundedFile(initial);
    if (typeof fsConstants.O_NOFOLLOW !== "number") throw new Error("O_NOFOLLOW is unavailable.");
    // O_NONBLOCK prevents a race-replaced FIFO from blocking before fstat rejects it.
    const handle = await fs.open(hookPath, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      requireRegularBoundedFile(opened);
      if (!sameStableFile(initial, opened)) throw new Error("Official hook changed while opening.");
      const source = await readBounded(handle);
      const final = await handle.stat();
      requireRegularBoundedFile(final);
      if (!sameStableFile(initial, final)) throw new Error("Official hook changed while reading.");
      return source.includes(MARKER) ? "present" : "unknown";
    } finally {
      await handle.close();
    }
  } catch {
    return "unknown";
  }
}

function unknownAtDeadline(probe: Promise<OfficialHookStatus>): Promise<OfficialHookStatus> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("unknown"), OFFICIAL_HOOK_PROBE_DEADLINE_MS);
    timer.unref?.();
    void probe.then(() => clearTimeout(timer), () => clearTimeout(timer));
  });
}

/**
 * Inspect the managed asset within a wall-clock budget. A timed-out filesystem
 * operation retains a process-wide lease until it settles, so later sessions
 * fail closed rather than accumulating probes against a stuck filesystem.
 */
export async function officialHookStatus(
  env: NodeJS.ProcessEnv = process.env,
  inspect: (base: string) => Promise<OfficialHookStatus> = probeOfficialHook,
): Promise<OfficialHookStatus> {
  const base = officialHookBase(env);
  if (!base) return "unknown";
  const lease = processCoordinator.acquireOfficialProbe();
  if (!lease) return "unknown";
  const probe = Promise.resolve().then(() => inspect(base)).then(
    (status) => status,
    () => "unknown" as const,
  );
  void probe.finally(() => processCoordinator.releaseOfficialProbe(lease));
  return Promise.race([probe, unknownAtDeadline(probe)]);
}

/** Compatibility helper; unknown is fail-closed just like a managed integration. */
export async function officialHookDetected(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return (await officialHookStatus(env)) !== "absent";
}
