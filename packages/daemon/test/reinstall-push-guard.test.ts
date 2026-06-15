import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "@chorus/proc";
import { ChorusBus, newId } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { GitService } from "@chorus/git-service";
import { AppController } from "../src/controller.js";

test("reinstallPushGuards rewrites a stale/broken pre-push hook", async () => {
  // A clone whose .git/hooks/pre-push has the old broken `pat) pat) pat)` form.
  const clone = mkdtempSync(join(tmpdir(), "chorus-hook-"));
  mkdirSync(join(clone, ".git", "hooks"), { recursive: true });
  const hookPath = join(clone, ".git", "hooks", "pre-push");
  writeFileSync(
    hookPath,
    "#!/bin/sh\ncase \"$x\" in\n  refs/heads/main) refs/heads/main) refs/heads/master)\n  exit 1 ;;\nesac\n",
    "utf8",
  );
  // Sanity: the broken hook is indeed invalid shell.
  const before = await run("sh", ["-n", hookPath], { throwOnError: false });
  assert.notEqual(before.code, 0, "precondition: hook should start broken");

  const db = new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-hookdb-")), "t.db"));
  const id = newId("proj");
  db.insertProject({
    id,
    repoUrl: "owner/repo",
    localPath: clone,
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: true,
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  });

  const ctrl = new AppController({
    db,
    bus: new ChorusBus(),
    git: new GitService(),
    backends: {} as never,
    orchestrator: {} as never,
    notifier: {} as never,
    config: { dataDir: "/tmp" } as never,
    detectedBackends: [],
  });

  await ctrl.reinstallPushGuards();

  // Now valid shell, blocks main, allows ticket branches.
  const after = await run("sh", ["-n", hookPath], { throwOnError: false });
  assert.equal(after.code, 0, "hook should be valid after reinstall");
  const blocked = await run("sh", [hookPath], { input: "refs/heads/x a refs/heads/main b\n" });
  assert.equal(blocked.code, 1);
  const allowed = await run("sh", [hookPath], {
    input: "refs/heads/x a refs/heads/chorus/ticket-1 b\n",
  });
  assert.equal(allowed.code, 0);
  db.close();
});
