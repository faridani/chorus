import { existsSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { run } from "@chorus/proc";
import { Mutex } from "./mutex.js";

/** A pull request as reported by `gh`. */
export interface PrInfo {
  url: string;
  number: number | null;
  /** GitHub PR state: OPEN | MERGED | CLOSED. */
  state: string;
  /** ISO timestamp when merged, or null if not merged. */
  mergedAt: string | null;
}

/**
 * All git access funnels through here. A single mutex serializes every
 * operation that mutates shared refs/objects (clone, fetch, worktree add,
 * push), which is what keeps parallel agents from corrupting `.git`.
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

  async headCommit(localPath: string, ref = "HEAD"): Promise<string> {
    const r = await this.git(["rev-parse", ref], localPath, true);
    return r.stdout.trim();
  }

  /**
   * Add a worktree on a fresh branch cut from the latest `origin/<baseBranch>`.
   * Fetches first so the ticket branch (and the PR it later opens) targets the
   * current state of the base branch on GitHub.
   */
  async addWorktree(
    localPath: string,
    worktreePath: string,
    branch: string,
    baseBranch: string,
  ): Promise<void> {
    await this.mutex.run(async () => {
      await this.gitUnlocked(["fetch", "origin", baseBranch], localPath, false);
      await this.gitUnlocked(["worktree", "prune"], localPath, false);
      // Clear any leftover worktree dir from a crashed run; `worktree add`
      // refuses a non-empty target. `-B` force-creates/resets the branch so a
      // leftover branch of the same name doesn't fail the add.
      if (existsSync(worktreePath)) {
        await rm(worktreePath, { recursive: true, force: true });
        await this.gitUnlocked(["worktree", "prune"], localPath, false);
      }
      await this.gitUnlocked(
        ["worktree", "add", "-B", branch, worktreePath, `origin/${baseBranch}`],
        localPath,
        true,
      );
    });
  }

  /**
   * Bring the main clone's working tree up to the latest `origin/<baseBranch>`.
   * The clone is read-only context for the orchestrator (it inspects it to plan
   * delegation); a clone left at its original checkout goes stale as the base
   * branch advances, so the orchestrator would reason about outdated code.
   * Best-effort: if the fetch/reset fails (e.g. offline) we keep the prior
   * checkout rather than aborting the session.
   */
  async syncToBase(localPath: string, baseBranch: string): Promise<void> {
    await this.mutex.run(async () => {
      await this.gitUnlocked(["fetch", "origin", baseBranch], localPath, false);
      await this.gitUnlocked(["reset", "--hard", `origin/${baseBranch}`], localPath, false);
      // Drop stray untracked files left by an old checkout (ignored files kept).
      await this.gitUnlocked(["clean", "-fd"], localPath, false);
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

  /** Summarize a branch's work vs a base ref: commit subjects + changed files. */
  async branchSummary(
    localPath: string,
    baseRef: string,
    branch: string,
  ): Promise<{ commits: string[]; files: string[] }> {
    const log = await this.git(["log", "--oneline", `${baseRef}..${branch}`], localPath, false);
    const diff = await this.git(["diff", "--name-only", `${baseRef}..${branch}`], localPath, false);
    const commits = log.code === 0 ? log.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    const files = diff.code === 0 ? diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
    return { commits, files };
  }

  /** Unified diff of `branch` vs `baseRef` (empty string if none / on error). */
  async diff(localPath: string, baseRef: string, branch: string): Promise<string> {
    const r = await this.git(["diff", `${baseRef}..${branch}`], localPath, false);
    return r.code === 0 ? r.stdout : "";
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

  /**
   * Stage and commit ALL changes in a worktree (tracked + untracked). A backstop
   * for when an agent edits files but forgets to commit before returning — those
   * changes are otherwise invisible to the acceptance gate (which judges the
   * committed branch) and would be lost on the next reset. Returns the new HEAD,
   * or null if there was nothing to commit. The worktree has its own HEAD/index,
   * so this is safe to run without the shared main-checkout mutex.
   */
  async commitAll(worktreePath: string, message: string): Promise<string | null> {
    const status = await this.git(["status", "--porcelain"], worktreePath, false);
    if (status.code !== 0 || status.stdout.trim() === "") return null;
    const add = await this.git(["add", "-A"], worktreePath, false);
    if (add.code !== 0) {
      throw new Error(`git add -A failed in ${worktreePath}: ${add.stderr.trim()}`);
    }
    const commit = await this.git(["commit", "-m", message], worktreePath, false);
    if (commit.code !== 0) {
      throw new Error(`git commit failed in ${worktreePath}: ${commit.stderr.trim()}`);
    }
    const head = await this.git(["rev-parse", "HEAD"], worktreePath, false);
    return head.stdout.trim();
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
   * Push a ticket branch to `origin` (force-with-lease so a re-run that adds
   * commits updates the already-open PR). Chorus — not the agent — performs
   * this; the pre-push guard only blocks protected branches, so ticket
   * branches (`chorus/ticket-*`) push cleanly.
   */
  async pushBranch(localPath: string, branch: string): Promise<void> {
    await this.mutex.run(async () => {
      const r = await this.gitUnlocked(
        ["push", "-u", "origin", branch, "--force-with-lease"],
        localPath,
        false,
      );
      if (r.code !== 0) {
        throw new Error(`git push failed for ${branch}: ${r.stderr.trim() || r.stdout.trim()}`);
      }
    });
  }

  /**
   * Open a PR for `branch` against `baseBranch`, or return the existing one if
   * a PR for this head branch is already open (idempotent on re-runs — the
   * re-push above already updated it). `gh` infers the repo from origin and
   * uses the user's authenticated account.
   */
  async openOrUpdatePr(
    localPath: string,
    branch: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<PrInfo> {
    const existing = await this.getPrState(localPath, branch);
    if (existing) return existing;
    const create = await run(
      "gh",
      [
        "pr",
        "create",
        "--head",
        branch,
        "--base",
        baseBranch,
        "--title",
        title,
        "--body",
        body,
      ],
      { cwd: localPath, throwOnError: false },
    );
    if (create.code !== 0) {
      throw new Error(`gh pr create failed for ${branch}: ${create.stderr.trim() || create.stdout.trim()}`);
    }
    // Re-read to get the structured fields (number/state/url).
    const info = await this.getPrState(localPath, branch);
    if (info) return info;
    // Fall back to the URL printed by `gh pr create`.
    return { url: create.stdout.trim(), number: null, state: "OPEN", mergedAt: null };
  }

  /**
   * Query the PR (if any) for a head branch. Returns null when no PR exists.
   * The polling primitive: `state` flips to MERGED / CLOSED on GitHub.
   */
  async getPrState(localPath: string, branch: string): Promise<PrInfo | null> {
    const r = await run(
      "gh",
      ["pr", "view", branch, "--json", "url,number,state,mergedAt"],
      { cwd: localPath, throwOnError: false },
    );
    if (r.code !== 0) return null; // "no pull requests found for branch"
    try {
      const j = JSON.parse(r.stdout) as {
        url?: string;
        number?: number;
        state?: string;
        mergedAt?: string | null;
      };
      if (!j.url) return null;
      return {
        url: j.url,
        number: typeof j.number === "number" ? j.number : null,
        state: j.state ?? "OPEN",
        mergedAt: j.mergedAt ?? null,
      };
    } catch {
      return null;
    }
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
