import { ORCHESTRATOR_ROLE } from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";

/**
 * Brings persisted state back to a consistent point after a daemon restart.
 * Every stored PID is assumed dead, so we never reattach: any ticket that was
 * mid-flight is handed back to the orchestrator to re-triage (it sees whatever
 * work survives on the ticket's branch and decides what to do next).
 */
export class Reconciler {
  constructor(
    private readonly db: ChorusDb,
    private readonly git: GitService,
  ) {}

  async reconcile(): Promise<void> {
    // Close out runs/tasks that were live when we died.
    for (const run of this.db.listUnfinishedRuns()) {
      this.db.updateRun(run.id, { endedAt: Date.now(), terminalReason: "crashed" });
    }
    for (const task of this.db.listTasksByState("running")) {
      this.db.updateTask(task.id, { state: "interrupted", endedAt: Date.now() });
    }

    for (const project of this.db.listProjects()) {
      try {
        await this.git.pruneWorktrees(project.localPath);
        await this.git.abortMergeIfInProgress(project.localPath);
      } catch {
        /* project dir may be missing; ignore */
      }

      // Any ticket left mid-run (in_progress) goes back to the orchestrator to
      // re-triage. Its persistent branch (if any) is preserved so the work isn't
      // lost — the orchestrator will see it on review.
      for (const ticket of this.db.listTickets(project.id)) {
        if (ticket.status === "in_progress") {
          this.db.updateTicket(ticket.id, { status: "open", roleName: ORCHESTRATOR_ROLE });
        }
      }
    }
  }
}
