import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ClaudeBackend, CodexQuotaPolicy } from "@chorus/backends";

const policy = new CodexQuotaPolicy({
  exhaustionPatterns: ["rate.?limit", "quota", "\\b429\\b"],
  backoffStartMs: 1000,
  backoffMaxMs: 60_000,
});

test("prepare() runs the CLI update once and memoizes across calls", async (t) => {
  const fake = fakeUpdater(t, { exitCode: 0 });
  const backend = new ClaudeBackend({ quotaPolicy: policy, bin: fake.bin });

  const first = await backend.prepare();
  const second = await backend.prepare();

  assert.equal(first, "Updated claude CLI");
  assert.equal(second, "Updated claude CLI");
  // Memoized: the underlying `claude update` ran exactly once.
  assert.equal(fake.calls(), 1);
  assert.deepEqual(fake.lastArgv(), ["update"]);
});

test("prepare() returns null and does not throw when the update fails", async (t) => {
  const fake = fakeUpdater(t, { exitCode: 1 });
  const backend = new ClaudeBackend({ quotaPolicy: policy, bin: fake.bin });

  const note = await backend.prepare();

  assert.equal(note, null);
  assert.equal(fake.calls(), 1);
});

test("prepare() is a no-op when autoUpdate is disabled", async (t) => {
  const fake = fakeUpdater(t, { exitCode: 0 });
  const backend = new ClaudeBackend({ quotaPolicy: policy, bin: fake.bin, autoUpdate: false });

  const note = await backend.prepare();

  assert.equal(note, null);
  assert.equal(fake.calls(), 0);
});

function fakeUpdater(t: TestContext, opts: { exitCode: number }) {
  const root = mkdtempSync(join(tmpdir(), "chorus-cli-update-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const counter = join(root, "calls.log");
  const argvCapture = join(root, "argv.json");
  const bin = join(root, "claude");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
appendFileSync(${JSON.stringify(counter)}, "x");
writeFileSync(${JSON.stringify(argvCapture)}, JSON.stringify(process.argv.slice(2)));
process.exit(${opts.exitCode});
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(counter, "utf8").length;
      } catch {
        return 0;
      }
    },
    lastArgv: () => JSON.parse(readFileSync(argvCapture, "utf8")) as string[],
  };
}
