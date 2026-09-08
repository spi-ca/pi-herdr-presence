import { expect, test } from "bun:test";
import { handleFakeSocketError } from "./helpers/fake-socket.js";

test("fake socket tolerates only opted-in cross-platform peer closures", () => {
  for (const code of ["EPIPE", "ECONNRESET"] as const) {
    const error = Object.assign(new Error(code), { code });
    expect(() => handleFakeSocketError(error, false)).toThrow(code);
    expect(() => handleFakeSocketError(error, true)).not.toThrow();
  }

  const unexpected = Object.assign(new Error("unexpected"), { code: "ECONNABORTED" });
  expect(() => handleFakeSocketError(unexpected, true)).toThrow("unexpected");
});
