import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
  name: string;
  bin?: Record<string, string>;
  files?: string[];
  publishConfig?: { registry?: string; access?: string };
  engines?: Record<string, string>;
};

assert.equal(packageJson.name, "@carry-dream/clawer-ticket-server");
assert.deepEqual(packageJson.bin, { "clawer-ticket-server": "./dist/index.js" });
assert.deepEqual(packageJson.files, ["dist", "config/*.example.json", "skills/**", "README.md"]);
assert.deepEqual(packageJson.publishConfig, { registry: "https://registry.npmjs.org/", access: "public" });
assert.equal(packageJson.engines?.node, ">=20");

const entry = await readFile(new URL("../../dist/index.js", import.meta.url), "utf8");
assert.ok(entry.startsWith("#!/usr/bin/env node\n"), "published CLI entry must retain its Node shebang");

console.log("npm package manifest and CLI entry validate.");
