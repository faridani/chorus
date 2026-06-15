import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "@chorus/proc";
import { GitService } from "@chorus/git-service";

async function git(cwd: string, ...args: string[]) {
  await run("git", args, { cwd, throwOnError: true });
}

async function makeRepo(): Promise<{ repo: string; integration: string }> {
  const repo = mkdtempSync(join(tmpdir(), "chorus-harden-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.dev");
  await git(repo, "config", "user.name", "Tester");
  writeFileSync(join(repo, "f.txt"), "hi\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "checkout", "-q", "-b", "chorus/integration");
  return { repo, integration: "chorus/integration" };
}

test("installPushGuard writes a syntactically valid hook that blocks protected branches", async () => {
  const gs = new GitService();
  const { repo } = await makeRepo();
  // Includes a duplicate ("main") to exercise dedup.
  await gs.installPushGuard(repo, ["main", "master", "chorus/integration", "main"]);
  const hook = join(repo, ".git", "hooks", "pre-push");

  // Must be valid shell (the old impl emitted "pat) pat) pat)" → syntax error).
  const syntax = await run("sh", ["-n", hook], { throwOnError: false });
  assert.equal(syntax.code, 0, `hook has invalid shell syntax: ${syntax.stderr}`);

  // Blocks a push to a protected branch (remote_ref is the 3rd field).
  const blocked = await run("sh", [hook], { input: "refs/heads/main aaa refs/heads/main bbb\n" });
  assert.equal(blocked.code, 1);

  // Allows a normal feature/agent branch.
  const allowed = await run("sh", [hook], {
    input: "refs/heads/chorus/ticket-x aaa refs/heads/chorus/ticket-x bbb\n",
  });
  assert.equal(allowed.code, 0);
});

test("installPushGuard with no protected branches produces a valid pass-through hook", async () => {
  const gs = new GitService();
  const { repo } = await makeRepo();
  await gs.installPushGuard(repo, []);
  const hook = join(repo, ".git", "hooks", "pre-push");
  const syntax = await run("sh", ["-n", hook], { throwOnError: false });
  assert.equal(syntax.code, 0, syntax.stderr);
  const r = await run("sh", [hook], { input: "refs/heads/main a refs/heads/main b\n" });
  assert.equal(r.code, 0);
});

test("addWorktree recovers from a leftover worktree directory", async () => {
  const gs = new GitService();
  const { repo, integration } = await makeRepo();
  const wt = join(repo, "..", `wt-leftover-${Date.now()}`);
  // Simulate a directory left behind by a crashed run.
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, "junk.txt"), "stale\n");

  await gs.addWorktree(repo, wt, "chorus/ticket-leftover", integration);
  assert.equal(await gs.isWorktreeClean(wt), true);
});

test("commitFile is a no-op when nothing changed and surfaces the new commit when it does", async () => {
  const gs = new GitService();
  const { repo } = await makeRepo();
  const before = await gs.headCommit(repo, "chorus/integration");

  const c1 = await gs.commitFile(repo, "CHANGELOG.md", "v1\n", "add changelog");
  assert.notEqual(c1, before); // a real commit happened

  // Same content again → nothing staged → no new commit, returns current HEAD.
  const c2 = await gs.commitFile(repo, "CHANGELOG.md", "v1\n", "noop");
  assert.equal(c2, c1);
});

test("commitFile(branch) commits on the target branch even if HEAD is elsewhere", async () => {
  const gs = new GitService();
  const { repo } = await makeRepo(); // currently on chorus/integration
  await git(repo, "checkout", "main"); // move HEAD off integration

  const c = await gs.commitFile(repo, "CHANGELOG.md", "log\n", "changelog", "chorus/integration");
  // The commit lands on integration...
  assert.equal(await gs.headCommit(repo, "chorus/integration"), c);
  // ...and main does NOT have the changelog file.
  const onMain = await run("git", ["cat-file", "-e", "main:CHANGELOG.md"], {
    cwd: repo,
    throwOnError: false,
  });
  assert.notEqual(onMain.code, 0);
});
