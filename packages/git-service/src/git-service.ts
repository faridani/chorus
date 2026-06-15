import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "@chorus/proc";
import { Mutex } from "./mutex.js";

export interface MergeOutcome {
  status: "merged" | "conflicted";
  mergeCommit: string | null;
  conflictFiles: string[];
}

/**
 * All git access funnels through here. A single mutex serializes every
 * operation that mutates shared refs/objects (clone, fetch, worktree add,
 * merge), which is what keeps parallel agents from corrupting `.git`.
 * Per-worktree file edits by agents happen outside this class and are safe.
 */
export class GitService {
  private readonly mutex = new Mutex();

  /** Clone via `gh` so it uses the user's authenticated account. */
  async clone(repoUrl: string, localPath: string): Promise<void> {
    await this.mutex.run(async () => {
      await mkdir(dirname(localPath), { recursive: true });
      const r = await run("gh", ["repo", "clone", repoUrl, localPath], { throwOnError: true });
      void r;
    });
  }

  async detectDefaultBranch(localPath: string): Promise<string> {
    // Prefer origin/HEAD; fall back to the current branch.
    const r = await this.git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], localPath, false);
    if (r.code === 0 && r.stdout.trim()) {
      return r.stdout.trim().replace(/^origin\//, "");
    }
    const cur = await this.git(["rev-parse", "--abbrev-ref", "HEAD"], localPath, true);
    return cur.stdout.trim();
  }

  /** Create (if needed) and check out the integration branch off the base. */
  async ensureIntegrationBranch(
    localPath: string,
    baseBranch: string,
    integrationBranch: string,
  ): Promise<void> {
    await this.mutex.run(async () => {
      await this.gitUnlocked(["fetch", "origin"], localPath, false);
      const exists = await this.gitUnlocked(
        ["rev-parse", "--verify", "--quiet", integrationBranch],
        localPath,
        false,
      );
      if (exists.code === 0) {
        await this.gitUnlocked(["checkout", integrationBranch], localPath, true);
      } else {
        await this.gitUnlocked(["checkout", "-b", integrationBranch, baseBranch], localPath, true);
      }
    });
  }

  async headCommit(localPath: string, ref = "HEAD"): Promise<string> {
    const r = await this.git(["rev-parse", ref], localPath, true);
    return r.stdout.trim();
  }

  /** Add a worktree on a fresh branch cut from `baseRef`. */
  async addWorktree(
    localPath: string,
    worktreePath: string,
    branch: string,
    baseRef: string,
  ): Promise<void> {
    await this.mutex.run(async () => {
      await this.gitUnlocked(["worktree", "prune"], localPath, false);
      // Clear any leftover worktree dir from a crashed run; `worktree add`
      // refuses a non-empty target. `-B` force-creates/resets the branch so a
      // leftover branch of the same name doesn't fail the add.
      if (existsSync(worktreePath)) {
        await rm(worktreePath, { recursive: true, force: true });
        await this.gitUnlocked(["worktree", "prune"], localPath, false);
      }
      await this.gitUnlocked(
        ["worktree", "add", "-B", branch, worktreePath, baseRef],
        localPath,
        true,
      );
    });
  }

  async removeWorktree(localPath: string, worktreePath: string): Promise<void> {
    await this.mutex.run(async () => {
      await this.gitUnlocked(["worktree", "remove", "--force", worktreePath], localPath, false);
      await this.gitUnlocked(["worktree", "prune"], localPath, false);
    });
  }

  async pruneWorktrees(localPath: string): Promise<void> {
    await this.mutex.run(() => this.gitUnlocked(["worktree", "prune"], localPath, false).then(() => {}));
  }

  /**
   * Check out a branch in the main checkout (best-effort). Used on boot to
   * restore HEAD to the integration branch after a crash mid-promote, so later
   * changelog commits don't land on the wrong branch.
   */
  async checkout(localPath: string, branch: string): Promise<void> {
    await this.mutex.run(() =>
      this.gitUnlocked(["checkout", branch], localPath, false).then(() => {}),
    );
  }

  /** True if `branch` has commits beyond `baseCommit`. */
  async hasNewCommits(localPath: string, baseCommit: string, branch: string): Promise<boolean> {
    const r = await this.git(["rev-list", "--count", `${baseCommit}..${branch}`], localPath, false);
    if (r.code !== 0) return false;
    return Number(r.stdout.trim()) > 0;
  }

  /** True if the worktree has no uncommitted changes. */
  async isWorktreeClean(worktreePath: string): Promise<boolean> {
    const r = await this.git(["status", "--porcelain"], worktreePath, false);
    return r.code === 0 && r.stdout.trim() === "";
  }

  /** Abort any half-finished merge left by a crash. */
  async abortMergeIfInProgress(localPath: string): Promise<void> {
    const mergeHead = join(localPath, ".git", "MERGE_HEAD");
    if (existsSync(mergeHead)) {
      await this.mutex.run(() =>
        this.gitUnlocked(["merge", "--abort"], localPath, false).then(() => {}),
      );
    }
  }

  /**
   * Merge an agent branch into the integration branch with `--no-ff`
   * (each ticket becomes one revertable merge commit). On conflict, abort
   * cleanly and report the conflicting files; the agent branch is untouched.
   */
  async mergeIntoIntegration(
    localPath: string,
    integrationBranch: string,
    branch: string,
    message: string,
  ): Promise<MergeOutcome> {
    return this.mutex.run(async () => {
      await this.gitUnlocked(["checkout", integrationBranch], localPath, true);
      const merge = await this.gitUnlocked(
        ["merge", "--no-ff", "-m", message, branch],
        localPath,
        false,
      );
      if (merge.code === 0) {
        const commit = await this.gitUnlocked(["rev-parse", "HEAD"], localPath, true);
        return { status: "merged", mergeCommit: commit.stdout.trim(), conflictFiles: [] };
      }
      // Conflict (or other failure) — collect unmerged paths, then abort.
      const conflicts = await this.gitUnlocked(
        ["diff", "--name-only", "--diff-filter=U"],
        localPath,
        false,
      );
      const conflictFiles = conflicts.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      await this.gitUnlocked(["merge", "--abort"], localPath, false);
      return { status: "conflicted", mergeCommit: null, conflictFiles };
    });
  }

  /**
   * Human-approved promotion: merge the integration branch into the base
   * branch (e.g. `main`) locally with `--no-ff`. This is only ever invoked
   * from the explicit approval action — never autonomously. Pushing remains
   * the human's decision (and the pre-push guard still blocks accidental
   * pushes to protected branches).
   */
  async mergeIntegrationToBase(
    localPath: string,
    baseBranch: string,
    integrationBranch: string,
  ): Promise<MergeOutcome> {
    return this.mutex.run(async () => {
      await this.gitUnlocked(["checkout", baseBranch], localPath, true);
      const merge = await this.gitUnlocked(
        ["merge", "--no-ff", "-m", `chorus: promote ${integrationBranch} to ${baseBranch}`, integrationBranch],
        localPath,
        false,
      );
      if (merge.code === 0) {
        const commit = await this.gitUnlocked(["rev-parse", "HEAD"], localPath, true);
        // Return to the integration branch so agents keep building on it.
        await this.gitUnlocked(["checkout", integrationBranch], localPath, false);
        return { status: "merged", mergeCommit: commit.stdout.trim(), conflictFiles: [] };
      }
      const conflicts = await this.gitUnlocked(
        ["diff", "--name-only", "--diff-filter=U"],
        localPath,
        false,
      );
      const conflictFiles = conflicts.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      await this.gitUnlocked(["merge", "--abort"], localPath, false);
      await this.gitUnlocked(["checkout", integrationBranch], localPath, false);
      return { status: "conflicted", mergeCommit: null, conflictFiles };
    });
  }

  /**
   * Write a file in the main checkout, commit it, return the commit. When
   * `branch` is given, check it out first so the commit can't land on whatever
   * branch HEAD happened to be on (e.g. after a promote-to-base).
   */
  async commitFile(
    localPath: string,
    relPath: string,
    content: string,
    message: string,
    branch?: string,
  ): Promise<string> {
    return this.mutex.run(async () => {
      if (branch) {
        await this.gitUnlocked(["checkout", branch], localPath, true);
      }
      const full = join(localPath, relPath);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, content, "utf8");
      await this.gitUnlocked(["add", relPath], localPath, true);
      // Distinguish "nothing changed" (a no-op, fine) from a real commit
      // failure (hook rejection, index lock, in-progress merge), which the old
      // code silently swallowed as success.
      const staged = await this.gitUnlocked(["diff", "--cached", "--quiet"], localPath, false);
      if (staged.code === 0) {
        return this.headCommitUnlocked(localPath); // nothing staged to commit
      }
      const commit = await this.gitUnlocked(["commit", "-m", message], localPath, false);
      if (commit.code !== 0) {
        throw new Error(`git commit failed for ${relPath}: ${commit.stderr.trim()}`);
      }
      return this.headCommitUnlocked(localPath);
    });
  }

  /**
   * Install a local pre-push hook that rejects pushes to protected branches.
   * Belt-and-braces given agents run with full sandbox access and *could*
   * attempt a push themselves.
   */
  async installPushGuard(localPath: string, protectedBranches: string[]): Promise<void> {
    const hookPath = join(localPath, ".git", "hooks", "pre-push");
    // Dedupe (base branch is often "main", passed twice) and build a single
    // `|`-joined case pattern. A naive `pat) pat) pat)` is invalid shell and
    // makes the hook error on *every* push.
    const unique = [...new Set(protectedBranches.filter((b) => b.trim()))];
    const pattern = unique.map((b) => `refs/heads/${b}`).join("|");
    const script = unique.length
      ? `#!/bin/sh
# Installed by Chorus: block pushes to protected branches.
while read local_ref local_sha remote_ref remote_sha; do
  case "$remote_ref" in
    ${pattern})
      echo "chorus: pushing to a protected branch is not allowed ($remote_ref)" >&2
      exit 1
      ;;
  esac
done
exit 0
`
      : `#!/bin/sh
# Installed by Chorus: no protected branches configured.
exit 0
`;
    await writeFile(hookPath, script, "utf8");
    await chmod(hookPath, 0o755);
  }

  // ---- internals ----
  private async headCommitUnlocked(localPath: string): Promise<string> {
    const r = await this.gitUnlocked(["rev-parse", "HEAD"], localPath, true);
    return r.stdout.trim();
  }

  /**
   * Read-only git call that does NOT take the shared mutex. Read commands
   * (rev-parse, rev-list, status, symbolic-ref) are safe to run concurrently
   * with ref-mutating ops, so done-detection need not serialize behind merges.
   */
  private git(args: string[], cwd: string, throwOnError: boolean) {
    return run("git", args, { cwd, throwOnError });
  }

  /** Raw git call — only call when already holding the mutex. */
  private gitUnlocked(args: string[], cwd: string, throwOnError: boolean) {
    return run("git", args, { cwd, throwOnError });
  }
}
