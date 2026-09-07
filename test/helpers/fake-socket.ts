import * as fs from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";

export type FakeSocketResponse = string | undefined | { end: true };
export type FakeSocketContext = { expectPeerClosure(): void };

/** Keep unexpected server-side write failures visible to the owning test. */
export function handleFakeSocketError(error: Error, expectedPeerClosure: boolean): void {
  if (expectedPeerClosure && (error as NodeJS.ErrnoException).code === "EPIPE") return;
  throw error;
}

export async function fakeSocket(
  path: string,
  handler: (line: string, connection: FakeSocketContext) => FakeSocketResponse | Promise<FakeSocketResponse>,
): Promise<{ close(): Promise<void> }> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    let expectedPeerClosure = false;
    const connection: FakeSocketContext = {
      // A stalled handler must opt in before it yields. This is per socket,
      // rather than a server-wide suppression that could hide other failures.
      expectPeerClosure() { expectedPeerClosure = true; },
    };
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", (error) => handleFakeSocketError(error, expectedPeerClosure));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const response = await handler(buffer.slice(0, end), connection);
      if (response === undefined || socket.destroyed || socket.writableEnded) return;
      if (typeof response === "string") socket.end(`${response}\n`);
      else socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  await fs.chmod(path, 0o600);
  return { close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(path, { force: true }); } };
}
