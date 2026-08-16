import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolvePresenceConfig } from "./config.js";
import { registerPresenceHooks } from "./hooks.js";
import { PresenceRuntime } from "./runtime.js";

export { presenceStatusKey } from "./presentation.js";

/** Compose the configured runtime and Pi hook adapter. */
export function registerPresence(pi: ExtensionAPI): void {
  const config = resolvePresenceConfig();
  if (!config.enabled) return;

  const runtime = new PresenceRuntime(pi, config);
  registerPresenceHooks(pi, runtime);
}
