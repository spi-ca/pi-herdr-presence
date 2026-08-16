import { describe, expect, test } from "bun:test";
import { CMUX_TEXT_BYTES, decodeV1Response, decodeV2Response, encodeV1, encodeV2, PresenceProtocolError } from "../src/protocol.js";

describe("protocol codecs", () => {
  test("encodes bounded LF V2 RPC and validates its response", () => {
    const workspace = "00000000-0000-4000-8000-000000000001";
    const surface = "00000000-0000-4000-8000-000000000002";
    expect(encodeV2({ id: 1, method: "notification.create_for_surface", params: { workspace_id: workspace, surface_id: surface, title: "Pi", body: "Done" } })).toBe(`{"id":1,"method":"notification.create_for_surface","params":{"workspace_id":"${workspace}","surface_id":"${surface}","title":"Pi","body":"Done"}}\n`);
    expect(() => encodeV2({ id: 1, method: "notification.create_for_surface", params: { title: "Pi" } })).toThrow(PresenceProtocolError);
    const feed = { workspace_id: workspace, surface_id: surface, event: { session_id: "session-1", hook_event_name: "PreToolUse", _source: "pi", workspace_id: workspace, surface_id: surface, tool_call_id: "call-1", tool_name: "todo" } };
    expect(encodeV2({ id: 2, method: "feed.push", params: feed })).toContain('"session_id":"session-1"');
    expect(() => encodeV2({ id: 2, method: "feed.push", params: { ...feed, event: { ...feed.event, prompt: "private" } } })).toThrow(PresenceProtocolError);
    expect(() => encodeV2({ id: 2, method: "feed.push", params: { ...feed, event: { ...feed.event, hook_event_name: "UserPromptSubmit", tool_name: "todo" } } })).toThrow(PresenceProtocolError);
    expect(decodeV2Response('{"id":1,"ok":true,"result":{}}', 1)).toEqual({});
    expect(() => decodeV2Response('{"id":2,"ok":true,"result":{}}', 1)).toThrow(PresenceProtocolError);
    expect(() => decodeV2Response('{"id":1,"ok":false,"error":{"code":"denied","message":"No access"}}', 1)).toThrow(PresenceProtocolError);
  });
  test("enforces UTF-8 byte limits for multibyte V1 and V2 fields", () => {
    const workspace = "00000000-0000-4000-8000-000000000001";
    const surface = "00000000-0000-4000-8000-000000000002";
    const exactTitle = "😀".repeat(CMUX_TEXT_BYTES.notificationTitle / 4);
    const overTitle = `${exactTitle}a`;
    const exactV1 = "😀".repeat(CMUX_TEXT_BYTES.v1Text / 4);
    const overV1 = `${exactV1}a`;

    expect(() => encodeV2({ id: 1, method: "notification.create_for_surface", params: { workspace_id: workspace, surface_id: surface, title: exactTitle, body: "Done" } })).not.toThrow();
    expect(() => encodeV2({ id: 1, method: "notification.create_for_surface", params: { workspace_id: workspace, surface_id: surface, title: overTitle, body: "Done" } })).toThrow(PresenceProtocolError);
    expect(() => encodeV1({ command: "set_progress", tab: workspace, value: 0.5, label: exactV1 })).not.toThrow();
    expect(() => encodeV1({ command: "set_progress", tab: workspace, value: 0.5, label: overV1 })).toThrow(PresenceProtocolError);
  });

  test("encodes tab-targeted V1 text and requires the exact acknowledgement", () => {
    const tab = "00000000-0000-4000-8000-000000000000";
    expect(encodeV1({ command: "set_status", tab, panel: tab, key: "presence", label: "Pi running", icon: "play", color: "#2563eb", priority: 30 })).toBe(`set_status presence "Pi running" --icon=play --color=#2563eb --priority=30 --tab=${tab} --panel=${tab}\n`);
    expect(encodeV1({ command: "clear_status", tab, key: "presence" })).toBe(`clear_status presence --tab=${tab}\n`);
    expect(encodeV1({ command: "set_progress", tab, value: 0.5, label: "Working now" })).toBe(`set_progress 0.50 --label="Working now" --tab=${tab}\n`);
    expect(encodeV1({ command: "clear_progress", tab })).toBe(`clear_progress --tab=${tab}\n`);
    expect(encodeV1({ command: "log", tab, level: "info", message: "done" })).toBe(`log --level=info --source=pi-cmux-presence --tab=${tab} -- "done"\n`);
    expect(encodeV1({ command: "set_agent_pid", tab, panel: tab, key: "pi", pid: 123 })).toBe(`set_agent_pid pi 123 --tab=${tab} --panel=${tab}\n`);
    expect(encodeV1({ command: "set_agent_lifecycle", tab, panel: tab, key: "pi", lifecycle: "idle" })).toBe(`set_agent_lifecycle pi idle --tab=${tab} --panel=${tab}\n`);
    expect(encodeV1({ command: "report_meta_block", tab, key: "pi-presence", markdown: "1\n2\t3", priority: 50 })).toBe(`report_meta_block pi-presence --priority=50 --tab=${tab} -- 1\\n2\\t3\n`);
    expect(() => encodeV1({ command: "report_meta_block", tab, key: "pi-presence", markdown: "1\\n2", priority: 50 })).toThrow(PresenceProtocolError);
    expect(encodeV1({ command: "clear_agent_pid", tab, panel: tab, key: "pi" })).toBe(`clear_agent_pid pi --tab=${tab} --panel=${tab}\n`);
    expect(() => decodeV1Response("ok")).toThrow(PresenceProtocolError);
    expect(() => decodeV1Response("OK")).not.toThrow();
    expect(() => encodeV1({ command: "log", tab, level: "info", message: "bad\nvalue" })).toThrow(PresenceProtocolError);
  });
});
