import { expect, test } from "bun:test";
import { handleFakeSocketError } from "./helpers/fake-socket.js";

test("fake socket exposes unmarked EPIPE and tolerates only an opted-in peer closure", () => {
  const epipe = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  expect(() => handleFakeSocketError(epipe, false)).toThrow("broken pipe");
  expect(() => handleFakeSocketError(epipe, true)).not.toThrow();
  expect(() => handleFakeSocketError(new Error("reset"), true)).toThrow("reset");
});
