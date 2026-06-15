import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { run } from "@chorus/proc";
import { GitService } from "@chorus/git-service";

async function git(cwd: string, ...args: string[]) {
  const r = await run("git", args, { cwd, throwOnError: true });
  return r.stdout.trim();
}

async function makeRepo(): Promise<{ repo: string; integration: string }> {
  const repo = mkdtempSync(join(tmpdir(), "chorus-git-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.dev");
  await git(repo, "config", "user.name", "Tester");
  writeFileSync(join(repo, "file.txt"), "line1\nline2\nline3\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "checkout", "-q", "-b", "chorus/integration");
  return { repo, integration: "chorus/integration" };
}

test("worktree add + new commit detection + clean check", async () => {
  const gs = new GitService();
  const { repo, integration } = await makeRepo();
  const base = await gs.headCommit(repo, integration);
  const wt = join(repo, "..", `wt-${Date.now()}`);
  await gs.addWorktree(repo, wt, "chorus/ticket-1", integration);

  assert.equal(await gs.isWorktreeClean(wt), true);
  assert.equal(await gs.hasNewCommits(repo, base, "chorus/ticket-1"), false);

  writeFileSync(join(wt, "new.txt"), "hello\n");
  await git(wt, "add", ".");
  assert.equal(await gs.isWorktreeClean(wt), false);
  await git(wt, "commit", "-qm", "add new.txt");

  assert.equal(await gs.isWorktreeClean(wt), true);
  assert.equal(await gs.hasNewCommits(repo, base, "chorus/ticket-1"), true);
});

test("merge --no-ff into integration succeeds", async () => {
  const gs = new GitService();
  const { repo, integration } = await makeRepo();
  const wt = join(repo, "..", `wt-ok-${Date.now()}`);
  await gs.addWorktree(repo, wt, "chorus/ticket-ok", integration);
  writeFileSync(join(wt, "feature.txt"), "feature\n");
  await git(wt, "add", ".");
  await git(wt, "commit", "-qm", "feature");

  const outcome = await gs.mergeIntoIntegration(repo, integration, "chorus/ticket-ok", "merge ok");
  assert.equal(outcome.status, "merged");
  assert.ok(outcome.mergeCommit);
  // --no-ff means a merge commit with two parents.
  const parents = await git(repo, "rev-list", "--parents", "-n", "1", "HEAD");
  assert.equal(parents.split(" ").length, 3);
});

test("conflicting merge is reported and aborted cleanly", async () => {
  const gs = new GitService();
  const { repo, integration } = await makeRepo();

  // Branch A edits line2 and merges.
  const wtA = join(repo, "..", `wt-a-${Date.now()}`);
  await gs.addWorktree(repo, wtA, "chorus/ticket-a", integration);
  writeFileSync(join(wtA, "file.txt"), "line1\nAAA\nline3\n");
  await git(wtA, "commit", "-aqm", "A edits line2");
  const a = await gs.mergeIntoIntegration(repo, integration, "chorus/ticket-a", "merge A");
  assert.equal(a.status, "merged");

  // Branch B (cut from the OLD integration tip) also edits line2 → conflict.
  const wtB = join(repo, "..", `wt-b-${Date.now()}`);
  await gs.addWorktree(repo, wtB, "chorus/ticket-b", a.mergeCommit + "~1");
  writeFileSync(join(wtB, "file.txt"), "line1\nBBB\nline3\n");
  await git(wtB, "commit", "-aqm", "B edits line2");
  const b = await gs.mergeIntoIntegration(repo, integration, "chorus/ticket-b", "merge B");

  assert.equal(b.status, "conflicted");
  assert.ok(b.conflictFiles.includes("file.txt"));
  // After abort there must be no merge in progress.
  const status = await git(repo, "status", "--porcelain");
  assert.equal(status, "");
});
