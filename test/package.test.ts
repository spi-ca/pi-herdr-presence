import { expect, test } from "bun:test";

test("package version is valid SemVer and matches the newest changelog heading", async () => {
  const pkg = await Bun.file(new URL("../package.json", import.meta.url)).json();
  const changelog = await Bun.file(new URL("../CHANGELOG.md", import.meta.url)).text();
  const newestHeading = changelog.match(/^## (.+)$/m)?.[1];

  expect(Bun.semver.satisfies(pkg.version, "*")).toBe(true);
  expect(newestHeading).toBe(`[${pkg.version}]`);
});
