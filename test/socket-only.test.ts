import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("production source has no process execution API or command fallback", async () => {
  const root = join(import.meta.dir, "..");
  const content = await Promise.all((await sourceFiles(join(root, "src"))).concat(join(root, "index.ts")).map((file) => fs.readFile(file, "utf8")));
  const production = content.join("\n");
  for (const forbidden of [
    /\bpi\s*\.\s*exec\s*\(/,
    /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["'](?:node:)?child_process["']/,
    /\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)["']execa["']/,
    /\bBun\s*\.\s*(?:spawn|spawnSync)\s*\(/,
    /\bDeno\s*\.\s*Command\s*\(/,
    /\b(?:execa(?:\s*\.\s*[A-Za-z_$][\w$]*)?|execa(?:Command|CommandSync|Sync|Node))\s*\(/,
    /setWidget\(/, /\.ui\.setStatus\(/,
  ]) {
    expect(production).not.toMatch(forbidden);
  }
});
