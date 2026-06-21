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

async function gitCode(cwd: string, ...args: string[]) {
  const r = await run("git", args, { cwd, throwOnError: false });
  return r.code;
}

/**
 * Build a working clone backed by a bare `origin` remote (on `main`), the way
 * Chorus expects: ticket branches are cut from `origin/main` and pushed back.
 */
async function makeRepo(): Promise<{ repo: string; origin: string; base: string }> {
  const origin = mkdtempSync(join(tmpdir(), "chorus-origin-"));
  await git(origin, "init", "-q", "--bare", "-b", "main");

  const repo = mkdtempSync(join(tmpdir(), "chorus-git-"));
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "t@t.dev");
  await git(repo, "config", "user.name", "Tester");
  writeFileSync(join(repo, "file.txt"), "line1\nline2\nline3\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "remote", "add", "origin", origin);
  await git(repo, "push", "-q", "-u", "origin", "main");
  return { repo, origin, base: "main" };
}

test("worktree add (from origin/base) + new commit detection + clean check", async () => {
  const gs = new GitService();
  const { repo, base } = await makeRepo();
  const wt = join(repo, "..", `wt-${Date.now()}`);
  await gs.addWorktree(repo, wt, "chorus/ticket-1", base);
  const baseRef = `origin/${base}`;

  assert.equal(await gs.isWorktreeClean(wt), true);
  assert.equal(await gs.hasNewCommits(repo, baseRef, "chorus/ticket-1"), false);

  writeFileSync(join(wt, "new.txt"), "hello\n");
  await git(wt, "add", ".");
  assert.equal(await gs.isWorktreeClean(wt), false);
  await git(wt, "commit", "-qm", "add new.txt");

  assert.equal(await gs.isWorktreeClean(wt), true);
  assert.equal(await gs.hasNewCommits(repo, baseRef, "chorus/ticket-1"), true);
});

test("commitAll captures uncommitted tracked + untracked changes; no-op when clean", async () => {
  const gs = new GitService();
  const { repo, base } = await makeRepo();
  const wt = join(repo, "..", `wt-commitall-${Date.now()}`);
  await gs.addWorktree(repo, wt, "chorus/ticket-commitall", base);
  const baseRef = `origin/${base}`;

  // Clean worktree → no-op (null), no new commit.
  assert.equal(await gs.commitAll(wt, "nothing"), null);
  assert.equal(await gs.hasNewCommits(repo, baseRef, "chorus/ticket-commitall"), false);

  // Edit a tracked file + add an untracked one, leaving both uncommitted.
  writeFileSync(join(wt, "file.txt"), "changed\n");
  writeFileSync(join(wt, "added.txt"), "brand new\n");
  assert.equal(await gs.isWorktreeClean(wt), false);

  const head = await gs.commitAll(wt, "salvage worker changes");
  assert.ok(head && head.length >= 7);
  assert.equal(await gs.isWorktreeClean(wt), true);
  assert.equal(await gs.hasNewCommits(repo, baseRef, "chorus/ticket-commitall"), true);
  // Both files are in the commit.
  const files = await git(wt, "show", "--name-only", "--format=", "HEAD");
  assert.match(files, /added\.txt/);
  assert.match(files, /file\.txt/);
});

test("pushBranch publishes a ticket branch to origin", async () => {
  const gs = new GitService();
  const { repo, origin, base } = await makeRepo();
  const wt = join(repo, "..", `wt-push-${Date.now()}`);
  await gs.addWorktree(repo, wt, "chorus/ticket-push", base);
  writeFileSync(join(wt, "feature.txt"), "feature\n");
  await git(wt, "add", ".");
  await git(wt, "commit", "-qm", "feature");

  await gs.pushBranch(repo, "chorus/ticket-push");

  // The branch ref now exists on the bare origin.
  const sha = await git(origin, "rev-parse", "refs/heads/chorus/ticket-push");
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test("deleteBranch removes local and remote ticket branches", async () => {
  const gs = new GitService();
  const { repo, origin, base } = await makeRepo();
  const branch = "chorus/ticket-delete";
  const wt = join(repo, "..", `wt-delete-${Date.now()}`);
  await gs.addWorktree(repo, wt, branch, base);
  writeFileSync(join(wt, "delete-me.txt"), "delete branch\n");
  await git(wt, "add", ".");
  await git(wt, "commit", "-qm", "delete branch fixture");
  await gs.pushBranch(repo, branch);
  await gs.removeWorktree(repo, wt);

  assert.equal(await gitCode(repo, "show-ref", "--verify", `refs/heads/${branch}`), 0);
  assert.equal(await gitCode(origin, "show-ref", "--verify", `refs/heads/${branch}`), 0);

  assert.equal(await gs.deleteBranch(repo, branch), true);
  assert.notEqual(await gitCode(repo, "show-ref", "--verify", `refs/heads/${branch}`), 0);
  assert.notEqual(await gitCode(origin, "show-ref", "--verify", `refs/heads/${branch}`), 0);
  assert.equal(await gs.deleteBranch(repo, branch), false);
});

test("deleteBranch refuses non-Chorus branch names without deleting refs", async () => {
  const gs = new GitService();
  const { repo, origin } = await makeRepo();
  const branch = "feature/delete";
  await git(repo, "checkout", "-qb", branch);
  writeFileSync(join(repo, "feature.txt"), "keep this branch\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "feature fixture");
  await git(repo, "push", "-q", "-u", "origin", branch);
  await git(repo, "checkout", "-q", "main");

  await assert.rejects(() => gs.deleteBranch(repo, branch), /refusing to delete non-Chorus branch/);
  assert.equal(await gitCode(repo, "show-ref", "--verify", `refs/heads/${branch}`), 0);
  assert.equal(await gitCode(origin, "show-ref", "--verify", `refs/heads/${branch}`), 0);
});
