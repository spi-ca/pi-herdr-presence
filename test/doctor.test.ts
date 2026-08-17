import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { join } from "node:path";
import { formatPresenceDoctorReport, runPresenceDoctor } from "../src/doctor.js";
import { fakeSocket } from "./helpers/fake-socket.js";

const config = { enabled: true, timeoutMs: 100, maxQueue: 1 };

test("doctor accepts only canonical protocol-19/20 pong and pane binding", async () => {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-doctor-"));
  const socket = join(dir, "socket");
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line);
    expect(["ping", "pane.get"]).toContain(request.method);
    const result = request.method === "ping" ? { type: "pong", protocol: 20 } : { type: "pane_info", pane: { pane_id: "pane", workspace_id: "workspace", tab_id: "tab", terminal_id: "terminal" } };
    return JSON.stringify({ id: request.id, result });
  });
  try {
    const report = await runPresenceDoctor({ HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(dir, "missing") }, config);
    expect(report).toMatchObject({ environment: { identity: "configured" }, managedIntegration: "absent", socket: "safe", ping: "ok", paneBinding: "bound", ready: true });
  } finally { await server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("doctor rejects noncanonical ping and pane results", async () => {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-doctor-strict-"));
  const socket = join(dir, "socket");
  let mode: "pong" | "pane" = "pong";
  const server = await fakeSocket(socket, (line) => {
    const request = JSON.parse(line);
    const result = request.method === "ping"
      ? mode === "pong" ? { type: "pong", protocol: 21 } : { type: "pong", protocol: 19 }
      : { type: "pane_info", pane: { pane_id: "pane" }, extra: true };
    return JSON.stringify({ id: request.id, result });
  });
  try {
    const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: join(dir, "missing") };
    expect(await runPresenceDoctor(env, config)).toMatchObject({ ping: "failed", paneBinding: "not-run", ready: false });
    mode = "pane";
    expect(await runPresenceDoctor(env, config)).toMatchObject({ ping: "ok", paneBinding: "unverified", ready: false });
  } finally { await server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("disabled doctor remains diagnostic but does not probe the socket", async () => {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-doctor-disabled-"));
  const socket = join(dir, "socket");
  let requests = 0;
  const server = await fakeSocket(socket, () => { requests++; return ""; });
  try {
    const paneId = "doctor-pane-secret";
    const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: socket, HERDR_PANE_ID: paneId, PI_CODING_AGENT_DIR: join(dir, "missing") };
    const report = await runPresenceDoctor(env, { ...config, enabled: false });
    expect(report).toMatchObject({ enabled: false, environment: { identity: "configured" }, managedIntegration: "absent", socket: "not-run", ping: "not-run", paneBinding: "not-run", ready: false });
    const formatted = formatPresenceDoctorReport(report);
    expect(formatted).toContain("Herdr presence: disabled (not ready)");
    expect(formatted).toContain("enabled: false");
    expect(formatted).toContain("HERDR_SOCKET_PATH configured: true");
    expect(formatted).not.toContain(socket);
    expect(formatted).not.toContain(paneId);
    expect(requests).toBe(0);
  } finally { await server.close(); await fs.rm(dir, { recursive: true, force: true }); }
});

test("doctor reports a managed integration as an unrun socket probe", async () => {
  const dir = await fs.mkdtemp(join(os.tmpdir(), "herdr-doctor-managed-"));
  try {
    await fs.mkdir(join(dir, "extensions"));
    await fs.writeFile(join(dir, "extensions", "herdr-agent-state.ts"), "HERDR_INTEGRATION_ID=pi");
    const report = await runPresenceDoctor({ HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "missing.sock"), HERDR_PANE_ID: "pane", PI_CODING_AGENT_DIR: dir }, config);
    expect(report).toMatchObject({ managedIntegration: "present", socket: "not-run", ping: "not-run", paneBinding: "not-run", ready: false });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
