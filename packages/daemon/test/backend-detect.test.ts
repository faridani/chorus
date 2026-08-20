import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { type TestContext, test } from "node:test";
import { detectBackends } from "../src/backend-detect.js";

test("detectBackends marks installed Claude and Gemini as implemented", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "chorus-backends-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["codex", "claude", "gemini"]) fakeBin(dir, name);

  const originalPath = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${originalPath ?? ""}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const detected = await detectBackends();
  assert.equal(detected.find((b) => b.id === "claude")?.available, true);
  assert.equal(detected.find((b) => b.id === "claude")?.implemented, true);
  assert.equal(detected.find((b) => b.id === "gemini")?.available, true);
  assert.equal(detected.find((b) => b.id === "gemini")?.implemented, true);
});

function fakeBin(dir: string, name: string): void {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\necho "${name} 1.0.0"\n`, "utf8");
  chmodSync(path, 0o755);
}
