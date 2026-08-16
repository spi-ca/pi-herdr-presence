import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPresence } from "./src/presence.js";

/** Stable Pi package entry point; it installs passive TUI lifecycle observers only. */
export default function piHerdrPresence(pi: ExtensionAPI): void {
  registerPresence(pi);
}
