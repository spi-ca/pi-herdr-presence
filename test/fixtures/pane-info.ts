export type PaneInfoFixture = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  revision: number;
  agent?: string | null;
};

/** Schema-faithful Herdr 0.8.0 PaneInfo fixture. */
export const paneInfo = (overrides: Partial<PaneInfoFixture> = {}): PaneInfoFixture => ({
  pane_id: "pane",
  terminal_id: "terminal",
  workspace_id: "workspace",
  tab_id: "tab",
  focused: true,
  agent_status: "idle",
  revision: 0,
  agent: "pi",
  ...overrides,
});
