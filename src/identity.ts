import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasControlOrBidi } from "./validation.js";

export interface HerdrIdentity { paneId: string; workspaceId: string; socketPath: string; }
export interface SocketFingerprint { dev: number; ino: number; uid: number; }
const safe = (value: string | undefined): value is string => !!value && Buffer.byteLength(value, "utf8") <= 256 && !hasControlOrBidi(value);
/** Opaque IDs are capabilities, not display text: preserve and require canonical raw input. */
const safeOpaqueId = (value: string | undefined): value is string => safe(value) && value === value.trim();

/** Herdr itself supplies all three values; Linux/macOS Unix sockets only. */
export function readHerdrIdentity(env: NodeJS.ProcessEnv = process.env, platform = process.platform): HerdrIdentity | null {
  const paneId = env.HERDR_PANE_ID;
  const workspaceId = env.HERDR_WORKSPACE_ID;
  // Paths have distinct lexical validation below, so surrounding shell whitespace
  // is normalized only for this non-opaque filesystem input.
  const socketPath = env.HERDR_SOCKET_PATH?.trim();
  if (platform !== "linux" && platform !== "darwin") return null;
  if (env.HERDR_ENV !== "1" || !safeOpaqueId(paneId) || !safeOpaqueId(workspaceId) || !safe(socketPath) || socketPath.includes("\0") || !path.isAbsolute(socketPath)) return null;
  // Herdr IDs are opaque capabilities; never infer a workspace from a pane ID.
  return { paneId, workspaceId, socketPath };
}
function uid(): number | null { return typeof process.getuid === "function" ? process.getuid() : null; }
function trustedStickyTmp(name: string, entry: Stats): boolean { return (name === "/tmp" || name === "/private/tmp") && entry.uid === 0 && (entry.mode & 0o1000) !== 0; }
function safeDirectory(name: string, entry: Stats, currentUid: number): void { if (!entry.isDirectory()) throw new Error("Socket ancestor is not a directory."); if (trustedStickyTmp(name, entry)) return; if (entry.uid !== 0 && entry.uid !== currentUid) throw new Error("Socket ancestor owner is unsafe."); if ((entry.mode & 0o022) !== 0) throw new Error("Socket ancestor is replaceable."); }
/** Validate the exact lexical traversal; root-owned aliases such as macOS /tmp are resolved separately. */
async function lexicalDirectories(parent: string, currentUid: number): Promise<void> { const components = parent.split(path.sep).filter(Boolean); let current = path.parse(parent).root; safeDirectory(current, await fs.lstat(current), currentUid); for (const component of components) { current = path.join(current, component); const entry = await fs.lstat(current); if (entry.isSymbolicLink()) { if (entry.uid !== 0) throw new Error("Socket path contains an untrusted symlink ancestor."); continue; } safeDirectory(current, entry, currentUid); } }
/** Validate every actual ancestor after aliases have been resolved. */
async function resolvedDirectories(parent: string, currentUid: number): Promise<void> { for (let current = parent;;) { safeDirectory(current, await fs.lstat(current), currentUid); const next = path.dirname(current); if (next === current) return; current = next; } }
/** Unix transport validates owner-only socket and its complete lexical and resolved non-replaceable path on every connection. */
export async function safeSocketFingerprint(candidate: string): Promise<SocketFingerprint> { if (!path.isAbsolute(candidate) || candidate.includes("\0") || path.resolve(candidate) !== candidate) throw new Error("Socket path is invalid or contains ambiguous traversal."); const currentUid = uid(); if (currentUid === null) throw new Error("Current UID is unavailable."); const parent = path.dirname(candidate); await lexicalDirectories(parent, currentUid); const entry = await fs.lstat(candidate); if (!entry.isSocket() || entry.uid !== currentUid || (entry.mode & 0o077) !== 0) throw new Error("Socket is not owner-only for the current UID."); await resolvedDirectories(await fs.realpath(parent), currentUid); return { dev: entry.dev, ino: entry.ino, uid: entry.uid }; }
