import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectCommands } from "../src/controller.js";

function repoWith(scripts: Record<string, string> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "chorus-detect-"));
  if (scripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }), "utf8");
  return dir;
}

test("detects build+test and includes build in setup (monorepo dist trap)", () => {
  const r = detectCommands(repoWith({ build: "tsc -b", test: "node --test" }));
  assert.equal(r.setupCommand, "npm install && npm run build");
  assert.deepEqual(r.verifyCommands, ["npm run build", "npm test"]);
});

test("no build script → plain install, test only", () => {
  const r = detectCommands(repoWith({ test: "node --test" }));
  assert.equal(r.setupCommand, "npm install");
  assert.deepEqual(r.verifyCommands, ["npm test"]);
});

test("falls back to lint when there is no test script", () => {
  const r = detectCommands(repoWith({ lint: "eslint ." }));
  assert.deepEqual(r.verifyCommands, ["npm run lint"]);
});

test("non-Node repo (no package.json) → empty commands", () => {
  const r = detectCommands(repoWith(null));
  assert.equal(r.setupCommand, null);
  assert.deepEqual(r.verifyCommands, []);
});
