import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export const CMUX_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STABLE_SOCKET = path.join(os.homedir(), ".local", "state", "cmux", "cmux.sock");

export interface CmuxIdentity { workspaceId: string; surfaceId: string; }
export interface SocketFingerprint { dev: number; ino: number; uid: number; }

export function readCmuxIdentity(env: NodeJS.ProcessEnv = process.env): CmuxIdentity | null {
  const workspaceId = env.CMUX_WORKSPACE_ID?.trim();
  const surfaceId = env.CMUX_SURFACE_ID?.trim();
  if (!workspaceId || !surfaceId || !CMUX_UUID_RE.test(workspaceId) || !CMUX_UUID_RE.test(surfaceId)) return null;
  return { workspaceId, surfaceId };
}

function currentUid(): number | null {
  return typeof process.getuid === "function" ? process.getuid() : null;
}

function isTrustedStickyTmp(directory: string, mode: number, owner: number): boolean {
  return (directory === "/tmp" || directory === "/private/tmp") && owner === 0 && (mode & 0o1000) !== 0;
}

function validateDirectoryEntry(directory: string, entry: Stats, uid: number): void {
  if (!entry.isDirectory()) throw new Error("Socket ancestor is not a directory.");
  if (isTrustedStickyTmp(directory, entry.mode, entry.uid)) return;
  if (entry.uid !== 0 && entry.uid !== uid) throw new Error("Socket ancestor owner is unsafe.");
  if ((entry.mode & 0o022) !== 0) throw new Error("Socket ancestor is replaceable by another user.");
}

/** Validate every resolved ancestor so another local UID cannot replace the socket path. */
async function validateDirectoryChain(resolvedParent: string, uid: number): Promise<void> {
  let current = resolvedParent;
  for (;;) {
    validateDirectoryEntry(current, await fs.lstat(current), uid);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

/** Reject lexical indirection unless the symlink itself is root-owned; the resolved target is checked separately. */
async function validateLexicalParent(parentPath: string, uid: number): Promise<void> {
  if (path.resolve(parentPath) !== parentPath) throw new Error("Socket path contains ambiguous traversal.");
  const components = parentPath.split(path.sep).filter(Boolean);
  let current = path.parse(parentPath).root;
  validateDirectoryEntry(current, await fs.lstat(current), uid);
  for (const component of components) {
    current = path.join(current, component);
    const entry = await fs.lstat(current);
    if (entry.isSymbolicLink()) {
      if (entry.uid !== 0) throw new Error("Socket path contains an untrusted symlink ancestor.");
      continue;
    }
    validateDirectoryEntry(current, entry, uid);
  }
}

/** Validate an owner-only socket and its complete lexical and resolved non-replaceable path. */
export async function safeSocketFingerprint(candidate: string): Promise<SocketFingerprint> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error("Socket path is invalid.");
  const uid = currentUid();
  if (uid === null) throw new Error("Current UID is unavailable.");
  const socket = await fs.lstat(candidate);
  if (!socket.isSocket() || socket.uid !== uid || (socket.mode & 0o077) !== 0) throw new Error("Socket is not owner-only for the current UID.");
  const parentPath = path.dirname(candidate);
  await validateLexicalParent(parentPath, uid);
  const resolvedParent = await fs.realpath(parentPath);
  await validateDirectoryChain(resolvedParent, uid);
  return { dev: socket.dev, ino: socket.ino, uid: socket.uid };
}

async function isSafeSocket(candidate: string): Promise<string | null> {
  try {
    await safeSocketFingerprint(candidate);
    return candidate;
  } catch {
    return null;
  }
}

/** Prefer an explicitly configured safe socket, otherwise use only the stable per-user path. */
export async function resolveCmuxSocketPath(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const configured = env.CMUX_SOCKET_PATH?.trim();
  if (configured) return await isSafeSocket(configured);
  return await isSafeSocket(STABLE_SOCKET);
}
