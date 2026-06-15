import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { detectCommands } from "../src/controller.js";

function repoWith(t: TestContext, scripts: Record<string, string> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "chorus-detect-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (scripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts }), "utf8");
  return dir;
}

test("detects build+test and includes build in setup (monorepo dist trap)", (t) => {
  const r = detectCommands(repoWith(t, { build: "tsc -b", test: "node --test" }));
  assert.equal(r.setupCommand, "npm install && npm run build");
  assert.deepEqual(r.verifyCommands, ["npm run build", "npm test"]);
});

test("no build script → plain install, test only", (t) => {
  const r = detectCommands(repoWith(t, { test: "node --test" }));
  assert.equal(r.setupCommand, "npm install");
  assert.deepEqual(r.verifyCommands, ["npm test"]);
});

test("falls back to lint when there is no test script", (t) => {
  const r = detectCommands(repoWith(t, { lint: "eslint ." }));
  assert.deepEqual(r.verifyCommands, ["npm run lint"]);
});

test("non-Node repo (no package.json) → empty commands", (t) => {
  const r = detectCommands(repoWith(t, null));
  assert.equal(r.setupCommand, null);
  assert.deepEqual(r.verifyCommands, []);
});
