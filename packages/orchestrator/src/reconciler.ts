import { existsSync } from "node:fs";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";

/**
 * Brings persisted state back to a consistent point after a daemon restart.
 * Core principle: every stored PID is assumed dead (PIDs do not survive a
 * restart and may be reused), so we never reattach — we re-derive task state
 * from git and the database.
 */
export class Reconciler {
  constructor(
    private readonly db: ChorusDb,
    private readonly git: GitService,
  ) {}

  async reconcile(): Promise<void> {
    // 1. Close out runs that were live when we died.
    for (const run of this.db.listUnfinishedRuns()) {
      this.db.updateRun(run.id, { endedAt: Date.now(), terminalReason: "crashed" });
    }

    // 2. Per project: prune stale worktrees and abort any half-done merge.
    for (const project of this.db.listProjects()) {
      try {
        await this.git.pruneWorktrees(project.localPath);
        await this.git.abortMergeIfInProgress(project.localPath);
      } catch {
        /* project dir may be missing; ignore */
      }
    }

    // 3. Any task still marked running had its process killed by the restart.
    //    Re-derive: if it produced clean commits, surface for review; otherwise
    //    re-open the ticket for a fresh attempt.
    for (const task of this.db.listTasksByState("running")) {
      const project = this.db.getProject(task.projectId);
      const ticket = this.db.getTicket(task.ticketId);
      this.db.updateTask(task.id, { state: "interrupted", endedAt: Date.now() });
      if (!project || !ticket) continue;

      let salvageable = false;
      if (existsSync(task.worktreePath)) {
        try {
          const hasCommits = await this.git.hasNewCommits(
            project.localPath,
            task.baseCommit,
            task.branch,
          );
          const clean = await this.git.isWorktreeClean(task.worktreePath);
          salvageable = hasCommits && clean;
        } catch {
          salvageable = false;
        }
      }

      if (salvageable) {
        // Commits survived a clean stop — let a human decide before merging.
        this.db.updateTicket(ticket.id, { status: "needs_review" });
      } else {
        // Nothing useful left; re-open for a fresh attempt and drop the worktree.
        this.db.updateTicket(ticket.id, { status: "open" });
        try {
          await this.git.removeWorktree(project.localPath, task.worktreePath);
        } catch {
          /* ignore */
        }
      }
    }
  }
}
