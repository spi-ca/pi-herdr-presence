import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPresence } from "./src/presence.js";

/** Stable Pi package entry point. This extension registers lifecycle observers only. */
export default function piCmuxPresence(pi: ExtensionAPI): void {
  registerPresence(pi);
}
