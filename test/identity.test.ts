import { expect, test } from "bun:test";
import { readHerdrIdentity } from "../src/identity.js";

const valid = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_WORKSPACE_ID: "workspace", HERDR_PANE_ID: "opaque-pane" };

test("Herdr identity requires an explicit opaque workspace ID", () => {
  expect(readHerdrIdentity(valid, "linux")).toEqual({ socketPath: "/tmp/herdr.sock", workspaceId: "workspace", paneId: "opaque-pane" });
  expect(readHerdrIdentity({ ...valid, HERDR_WORKSPACE_ID: "" }, "linux")).toBeNull();
  expect(readHerdrIdentity({ ...valid, HERDR_WORKSPACE_ID: "workspace\u0000leak" }, "linux")).toBeNull();
  expect(readHerdrIdentity({ ...valid, HERDR_WORKSPACE_ID: " workspace" }, "linux")).toBeNull();
  expect(readHerdrIdentity({ ...valid, HERDR_WORKSPACE_ID: "workspace " }, "linux")).toBeNull();
  expect(readHerdrIdentity({ ...valid, HERDR_PANE_ID: " opaque-pane" }, "linux")).toBeNull();
  expect(readHerdrIdentity({ ...valid, HERDR_PANE_ID: "opaque-pane " }, "linux")).toBeNull();
  expect(readHerdrIdentity({ ...valid, HERDR_SOCKET_PATH: " /tmp/herdr.sock " }, "linux")?.socketPath).toBe("/tmp/herdr.sock");
  expect(readHerdrIdentity({ ...valid, HERDR_PANE_ID: "workspace:pane" }, "linux")?.workspaceId).toBe("workspace");
});
