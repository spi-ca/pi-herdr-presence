import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { hasControlOrBidi } from "./validation.js";

export interface HerdrIdentity { paneId: string; socketPath: string; }
export interface SocketFingerprint { dev: number; ino: number; uid: number; }
const safe = (value: string | undefined): value is string => !!value && value.length <= 256 && !hasControlOrBidi(value);

/** Herdr itself supplies all three values; Linux/macOS Unix sockets only. */
export function readHerdrIdentity(env: NodeJS.ProcessEnv = process.env, platform = process.platform): HerdrIdentity | null {
  const paneId = env.HERDR_PANE_ID?.trim();
  const socketPath = env.HERDR_SOCKET_PATH?.trim();
  if (platform !== "linux" && platform !== "darwin") return null;
  if (env.HERDR_ENV !== "1" || !safe(paneId) || !safe(socketPath) || socketPath.includes("\0") || !path.isAbsolute(socketPath)) return null;
  return { paneId, socketPath };
}
function uid(): number | null { return typeof process.getuid === "function" ? process.getuid() : null; }
function safeDirectory(name: string, entry: Stats, currentUid: number): void { if (!entry.isDirectory()) throw new Error("Socket ancestor is not a directory."); if (entry.uid !== 0 && entry.uid !== currentUid) throw new Error("Socket ancestor owner is unsafe."); const stickyTmp = (name === "/tmp" || name === "/private/tmp") && entry.uid === 0 && (entry.mode & 0o1000) !== 0; if (!stickyTmp && (entry.mode & 0o022) !== 0) throw new Error("Socket ancestor is replaceable."); }
async function directories(parent: string, currentUid: number): Promise<void> { let current = path.resolve(parent); for (;;) { const entry = await fs.lstat(current); if (entry.isSymbolicLink()) throw new Error("Socket path contains a symlink ancestor."); safeDirectory(current, entry, currentUid); const next = path.dirname(current); if (next === current) return; current = next; } }
/** Unix transport validates owner-only socket and its full non-replaceable path on every connection. */
export async function safeSocketFingerprint(candidate: string): Promise<SocketFingerprint> { if (!path.isAbsolute(candidate) || candidate.includes("\0")) throw new Error("Socket path is invalid."); const currentUid = uid(); if (currentUid === null) throw new Error("Current UID is unavailable."); const entry = await fs.lstat(candidate); if (!entry.isSocket() || entry.uid !== currentUid || (entry.mode & 0o077) !== 0) throw new Error("Socket is not owner-only for the current UID."); await directories(path.dirname(candidate), currentUid); return { dev: entry.dev, ino: entry.ino, uid: entry.uid }; }
