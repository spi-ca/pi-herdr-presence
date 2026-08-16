import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePresenceConfig } from "./config.js";
import { readHerdrIdentity } from "./identity.js";
import { registerPresenceHooks } from "./hooks.js";
import { PresenceRuntime } from "./runtime.js";
/** Compose only when Herdr has explicitly supplied this TUI pane's socket identity. */
export function registerPresence(pi: ExtensionAPI): void { const config=resolvePresenceConfig();if(!config.enabled||!readHerdrIdentity())return;registerPresenceHooks(pi,new PresenceRuntime(pi,config)); }
