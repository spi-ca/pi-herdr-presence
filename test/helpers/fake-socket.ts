import * as fs from "node:fs/promises";
import net from "node:net";
import { dirname } from "node:path";

export type FakeSocketResponse = string | undefined | { end: true };

export async function fakeSocket(
  path: string,
  handler: (line: string) => FakeSocketResponse | Promise<FakeSocketResponse>,
): Promise<{ close(): Promise<void> }> {
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", async (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      const response = await handler(buffer.slice(0, end));
      if (response === undefined) return;
      if (typeof response === "string") socket.end(`${response}\n`);
      else socket.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
  await fs.chmod(path, 0o600);
  return { close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); await fs.rm(path, { force: true }); } };
}
