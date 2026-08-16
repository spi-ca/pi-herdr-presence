import { describe, expect, test } from "bun:test";
import { PresenceClient } from "../src/client.js";
import type { PresenceConfig } from "../src/config.js";

const identity = { workspaceId: "00000000-0000-4000-8000-000000000001", surfaceId: "00000000-0000-4000-8000-000000000002" };
const config: PresenceConfig = { enabled: true, timeoutMs: 100, maxQueue: 4, progress: true, notifications: true, flash: true, notificationPolicy: "background", flashPolicy: "errors", subagentChildProfile: false, suppressNativeNotifications: false, suppressNativeFlash: false, log: false, sidebar: true, nativeLifecycle: true, feed: true, metaBlock: true, autoTitle: true, resumeFallback: true, finalClearMs: 0, maxLabelChars: 96 };

function clientWith(responder: (request: { id: number; method: string; params: Record<string, unknown> }) => unknown, capabilityResult: unknown = { protocol: "cmux-socket", version: 2, access_mode: "automation", socket_path: "/tmp/cmux.sock", methods: ["surface.resume.get", "surface.resume.set", "surface.resume.clear", ...Array.from({ length: 252 }, (_, index) => `unrelated.method.${index}`)] }) {
  const requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  const transport = {
    async request(line: string) {
      if (!line.startsWith("{")) return "OK";
      const request = JSON.parse(line) as { id: number; method: string; params: Record<string, unknown> };
      requests.push(request);
      const result = request.method === "system.capabilities" ? capabilityResult : responder(request);
      return JSON.stringify({ id: request.id, ok: true, result });
    },
    async close() {},
  };
  return { client: new PresenceClient(identity, transport as never, config), requests };
}

describe("progress ownership", () => {
  test("does not write or clear workspace progress when progress output is disabled", async () => {
    const lines: string[] = [];
    const transport = {
      async request(line: string) {
        lines.push(line.trimEnd());
        if (!line.startsWith("{")) return "OK";
        const request = JSON.parse(line) as { id: number };
        return JSON.stringify({
          id: request.id,
          ok: true,
          result: { protocol: "cmux-socket", version: 2, methods: [] },
        });
      },
      async close() {},
    };
    const client = new PresenceClient(identity, transport as never, { ...config, progress: false });

    await client.initialize();
    await client.initializeOwnedProgress();
    await client.progress(0.5, "Working");
    await client.clearProgress();
    await client.close();

    expect(lines.filter((line) => !line.startsWith("{"))).toEqual([]);
  });
});

describe("resume fallback", () => {
  test("does not use optional V2 methods for absent or malformed capabilities", async () => {
    const { client, requests } = clientWith(() => ({}), { protocol: "cmux-socket", version: 2, methods: "not-an-array" });
    await client.initialize();
    await client.flash();
    await client.installResumeFallback("session-1", "pi --session 'session-1'");
    expect(requests.map((request) => request.method)).toEqual(["system.capabilities"]);
  });
  test("refuses an existing nonmatching binding", async () => {
    const { client, requests } = clientWith((request) => request.method === "surface.resume.get" ? { resume_binding: { kind: "pi", source: "agent-hook", checkpoint_id: "other" } } : {});
    await client.initialize();
    await client.installResumeFallback("session-1", "pi --session 'session-1'");
    expect(requests.map((request) => request.method)).toEqual(["system.capabilities", "surface.resume.get"]);
  });
  test("waits for an in-flight install before clearing verified ownership", async () => {
    let releaseSet!: () => void;
    let gets = 0;
    const methods: string[] = [];
    const transport = {
      async request(line: string) {
        if (!line.startsWith("{")) return "OK";
        const request = JSON.parse(line) as { id: number; method: string };
        methods.push(request.method);
        let result: unknown = {};
        if (request.method === "system.capabilities") {
          result = { protocol: "cmux-socket", version: 2, methods: ["surface.resume.get", "surface.resume.set", "surface.resume.clear"] };
        } else if (request.method === "surface.resume.get") {
          gets += 1;
          result = { resume_binding: gets === 1 ? null : { kind: "pi", source: "agent-hook", checkpoint_id: "session-1" } };
        } else if (request.method === "surface.resume.set") {
          await new Promise<void>((resolve) => { releaseSet = resolve; });
        }
        return JSON.stringify({ id: request.id, ok: true, result });
      },
      async close() {},
    };
    const client = new PresenceClient(identity, transport as never, config);
    await client.initialize();

    const installing = client.installResumeFallback("session-1", "pi --session 'session-1'");
    while (!releaseSet) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const clearing = client.clearOwnedResumeFallback("session-1");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(methods).not.toContain("surface.resume.clear");

    releaseSet();
    await Promise.all([installing, clearing]);
    expect(methods.at(-1)).toBe("surface.resume.clear");
  });

  test("sets only after an empty get, verifies exact ownership, then clears it", async () => {
    let gets = 0;
    const { client, requests } = clientWith((request) => {
      if (request.method !== "surface.resume.get") return {};
      gets += 1;
      return { resume_binding: gets === 1 ? null : { kind: "pi", source: "agent-hook", checkpoint_id: "session-1" } };
    });
    await client.initialize();
    await client.installResumeFallback("session-1", "pi --session 'session-1'");
    await client.clearOwnedResumeFallback("session-1");
    expect(requests.map((request) => request.method)).toEqual(["system.capabilities", "surface.resume.get", "surface.resume.set", "surface.resume.get", "surface.resume.get", "surface.resume.clear"]);
    expect(requests.find((request) => request.method === "surface.resume.set")?.params).toMatchObject({ kind: "pi", source: "agent-hook", checkpoint_id: "session-1", command: "pi --session 'session-1'" });
  });
});
