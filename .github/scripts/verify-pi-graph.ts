import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

type ExpectedVersions = Record<string, string>;

function packageVersion(path: string): { name: string; version: string } {
  const value = JSON.parse(readFileSync(path, "utf8")) as { name?: unknown; version?: unknown };
  if (typeof value.name !== "string" || typeof value.version !== "string") throw new Error(`invalid package manifest: ${path}`);
  return { name: value.name, version: value.version };
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function entries(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

/**
 * Traverse every package's nested node_modules, including packages below any
 * scope and Bun's store. Real paths make store links and cyclic fixtures safe.
 */
export function installedPiPackages(root: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const visited = new Set<string>();

  const inspectPackage = (directory: string): void => {
    const manifest = join(directory, "package.json");
    if (!existsSync(manifest)) return;
    const pkg = packageVersion(manifest);
    if (!pkg.name.startsWith("@earendil-works/pi-")) return;
    const expectedDirectoryName = pkg.name.slice("@earendil-works/".length);
    if (directory.split("/").at(-1) !== expectedDirectoryName) {
      throw new Error(`unexpected Pi package identity in ${manifest}: ${pkg.name}`);
    }
    const versions = found.get(pkg.name) ?? new Set<string>();
    versions.add(pkg.version);
    found.set(pkg.name, versions);
  };

  const visitNodeModules = (directory: string): void => {
    if (!isDirectory(directory)) return;
    const real = realpathSync(directory);
    if (visited.has(real)) return;
    visited.add(real);

    const packages: string[] = [];
    for (const entry of entries(directory)) {
      const child = join(directory, entry);
      if (entry === ".bun") {
        for (const storeEntry of entries(child)) visitNodeModules(join(child, storeEntry, "node_modules"));
        continue;
      }
      if (entry.startsWith("@")) {
        for (const scopedName of entries(child)) {
          const scopedPackage = join(child, scopedName);
          if (isDirectory(scopedPackage)) packages.push(scopedPackage);
        }
      } else if (isDirectory(child)) {
        packages.push(child);
      }
    }

    for (const pkg of packages) {
      inspectPackage(pkg);
      visitNodeModules(join(pkg, "node_modules"));
    }
  };

  visitNodeModules(root);
  return found;
}

/** Verify that the complete selected matrix graph is present at exactly one version each. */
export function verifyPiGraph(root: string, expected: ExpectedVersions, declared: readonly string[]): void {
  const installed = installedPiPackages(root);
  for (const name of declared) {
    if (!(name in expected)) throw new Error(`no expected version declared for ${name}`);
  }
  for (const [name, version] of Object.entries(expected)) {
    const versions = installed.get(name);
    if (!versions) throw new Error(`expected Pi package was not installed: ${name}`);
    if (versions.size !== 1 || !versions.has(version)) {
      throw new Error(`${name}: expected only ${version}, installed ${[...versions].sort().join(", ")}`);
    }
    console.log(`${name}@${version}`);
  }
  for (const name of installed.keys()) {
    if (!(name in expected)) throw new Error(`unexpected installed Pi package: ${name}`);
  }
}

function expectFailure(action: () => void, description: string): void {
  try { action(); } catch { return; }
  throw new Error(`self-test did not reject ${description}`);
}

function writePackage(directory: string, name: string, version: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name, version })}\n`);
}

function selfTest(): void {
  const root = mkdtempSync(join(tmpdir(), "pi-graph-"));
  try {
    const nodeModules = join(root, "node_modules");
    writePackage(join(nodeModules, "@earendil-works/pi-ai"), "@earendil-works/pi-ai", "1.2.3");
    const nested = join(nodeModules, "@aws-sdk/client-example/node_modules/@earendil-works/pi-tui");
    writePackage(nested, "@earendil-works/pi-tui", "1.2.3");
    mkdirSync(join(nodeModules, ".bun/cycle"), { recursive: true });
    symlinkSync(nodeModules, join(nodeModules, ".bun/cycle/node_modules"));

    const expected = { "@earendil-works/pi-ai": "1.2.3", "@earendil-works/pi-tui": "1.2.3" };
    verifyPiGraph(nodeModules, expected, ["@earendil-works/pi-ai"]);
    writeFileSync(join(nested, "package.json"), '{"name":"@earendil-works/pi-tui","version":"9.9.9"}\n');
    expectFailure(() => verifyPiGraph(nodeModules, expected, ["@earendil-works/pi-ai"]), "a mismatched Pi package nested below a non-Pi scope");
    writeFileSync(join(nested, "package.json"), '{"name":"@earendil-works/pi-tui","version":"1.2.3"}\n');
    expectFailure(() => verifyPiGraph(nodeModules, { ...expected, "@earendil-works/pi-client": "1.2.3" }, ["@earendil-works/pi-ai"]), "a missing expected Pi dependency");
    console.log("synthetic generic scoped and cyclic Bun graph verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  if (process.argv[2] === "--self-test") return selfTest();
  const expected = JSON.parse(process.env.PI_GRAPH_EXPECTED ?? "") as ExpectedVersions;
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { devDependencies?: Record<string, string> };
  const declared = Object.keys(pkg.devDependencies ?? {}).filter((name) => name.startsWith("@earendil-works/pi-"));
  if (declared.length === 0) throw new Error("no declared Pi development packages");
  verifyPiGraph(join(process.cwd(), "node_modules"), expected, declared);
}

if (import.meta.main) main();
