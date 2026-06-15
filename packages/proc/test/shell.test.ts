import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { runShell } from "@chorus/proc";

test("runShell captures success output and ok=true", async () => {
  const dir = mkdtempSync(`${tmpdir()}/chorus-shell-`);
  const r = await runShell("echo hello", dir);
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.combined, /hello/);
});

test("runShell reports failure without throwing", async () => {
  const dir = mkdtempSync(`${tmpdir()}/chorus-shell-`);
  const r = await runShell("exit 3", dir);
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
});

test("runShell runs in the given cwd", async () => {
  const dir = mkdtempSync(`${tmpdir()}/chorus-shell-`);
  const r = await runShell("pwd", dir);
  assert.equal(r.ok, true);
  // macOS /tmp is a symlink to /private/tmp; match the trailing dir name.
  assert.match(r.combined.trim(), new RegExp(`${dir.split("/").pop()}$`));
});
