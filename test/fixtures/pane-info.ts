export type PaneInfoFixture = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused: boolean;
  cwd?: string | null;
  foreground_cwd?: string | null;
  label?: string | null;
  agent?: string | null;
  title?: string | null;
  terminal_title?: string | null;
  terminal_title_stripped?: string | null;
  display_agent?: string | null;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  state_labels?: Record<string, string>;
  tokens?: Record<string, string>;
  agent_session?: { source: string; agent: string; kind: "id" | "path"; value: string } | null;
  scroll?: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } | null;
  revision: number;
};

/** Complete schema-faithful Herdr 0.9.0 PaneInfo fixture. */
export const paneInfo = (overrides: Partial<PaneInfoFixture> = {}): PaneInfoFixture => ({
  pane_id: "pane",
  terminal_id: "terminal",
  workspace_id: "workspace",
  tab_id: "tab",
  focused: true,
  cwd: "/workspace",
  foreground_cwd: "/workspace",
  label: "Pi",
  agent: "pi",
  title: "Pi · idle",
  terminal_title: "Pi",
  terminal_title_stripped: "Pi",
  display_agent: "Pi",
  agent_status: "idle",
  state_labels: { idle: "Idle" },
  tokens: { summary: "idle" },
  agent_session: { source: "pi", agent: "pi", kind: "id", value: "session" },
  scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 24 },
  revision: 0,
  ...overrides,
});
