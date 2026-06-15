import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendRegistry } from "@chorus/backends";
import {
  type AgentResult,
  type ChorusBus,
  type Config,
  type Notifier,
  newId,
  type OrchestratorState,
  type Project,
  type Task,
  type TaskState,
  type Ticket,
} from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";
import { renderChangelog } from "./changelog.js";
import { buildAgentPrompt } from "./prompt.js";

export interface OrchestratorDeps {
  db: ChorusDb;
  git: GitService;
  backends: BackendRegistry;
  notifier: Notifier;
  bus: ChorusBus;
  config: Config;
}

/**
 * The hub. Owns the dispatch loop, agent execution, done-detection, merging
 * into the integration branch, the changelog, quota gating, and human
 * notifications. The only writer of task/merge/changelog state.
 */
export class Orchestrator {
  private state: OrchestratorState = "stopped";
  private timer: NodeJS.Timeout | undefined;
  /** taskId → live run handle, used for concurrency counting and stop(). */
  private readonly running = new Map<string, { stop: () => Promise<void> }>();
  private ticking = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  getState(): OrchestratorState {
    return this.state;
  }

  runningTaskIds(): string[] {
    return [...this.running.keys()];
  }

  start(): void {
    this.setState("running");
    if (!this.timer) {
      this.timer = setInterval(() => {
        this.tick().catch((e) => console.error("[chorus] tick error:", e));
      }, 4000);
    }
    this.tick().catch((e) => console.error("[chorus] tick error:", e));
  }

  pause(): void {
    this.setState("paused");
  }

  /** Stop dispatching and stop all running agents. */
  async stop(): Promise<void> {
    this.setState("stopped");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled([...this.running.values()].map((h) => h.stop()));
  }

  private setState(s: OrchestratorState): void {
    this.state = s;
    this.deps.bus.emit({ type: "orchestrator_state", state: s, at: Date.now() });
  }

  /** One iteration of the dispatch loop. Re-entrancy guarded. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.state !== "running") return;
      this.reconcileQuota();
      const quota = this.deps.db.getQuota();
      if (quota.state === "exhausted") return;

      // Resume quota-paused tasks whose retry time has arrived.
      for (const task of this.deps.db.listTasksByState("paused-quota")) {
        if (this.atCapacity()) break;
        if (task.resumeAt && task.resumeAt <= Date.now() && !this.running.has(task.id)) {
          void this.runTask(task, true).catch((e) => console.error("[chorus] runTask error:", e));
        }
      }

      // Dispatch new work.
      while (!this.atCapacity()) {
        const ticket = this.pickNextTicket();
        if (!ticket) break;
        await this.dispatchTicket(ticket);
      }
    } finally {
      this.ticking = false;
    }
  }

  private atCapacity(): boolean {
    return this.running.size >= this.deps.config.maxConcurrentAgents;
  }

  private reconcileQuota(): void {
    const quota = this.deps.db.getQuota();
    if (quota.state === "exhausted" && quota.resumeAt && quota.resumeAt <= Date.now()) {
      this.deps.db.setQuota({ ...quota, state: "available", resumeAt: null });
      this.deps.bus.emit({ type: "quota", state: "available", resumeAt: null, at: Date.now() });
    }
  }

  private pickNextTicket(): Ticket | undefined {
    for (const project of this.deps.db.listProjects()) {
      if (project.status !== "ready") continue;
      const ticket = this.deps.db.nextOpenTicket(project.id);
      if (ticket) return ticket;
    }
    return undefined;
  }

  // ---- dispatch ----
  private async dispatchTicket(ticket: Ticket): Promise<void> {
    const project = this.deps.db.getProject(ticket.projectId);
    if (!project) return;

    const role = ticket.roleName ? this.deps.db.getRole(project.id, ticket.roleName) ?? null : null;
    const backendId = role?.backendId ?? "codex";
    if (!this.deps.backends.has(backendId)) {
      this.failTicket(ticket, `No backend "${backendId}" registered.`);
      return;
    }

    const attempt = this.deps.db.listTasksForTicket(ticket.id).length + 1;
    if (attempt > this.deps.config.maxAttemptsPerTicket) {
      this.failTicket(
        ticket,
        `Exceeded max attempts (${this.deps.config.maxAttemptsPerTicket}).`,
      );
      return;
    }
    const branch = `chorus/ticket-${ticket.id}-a${attempt}`;
    const worktreePath = join(
      this.deps.config.dataDir,
      "worktrees",
      project.id,
      `${ticket.id}-a${attempt}`,
    );

    let baseCommit: string;
    try {
      baseCommit = await this.deps.git.headCommit(project.localPath, project.integrationBranch);
      await this.deps.git.addWorktree(project.localPath, worktreePath, branch, project.integrationBranch);
    } catch (err) {
      this.failTicket(ticket, `Failed to create worktree: ${String(err)}`);
      return;
    }

    const now = Date.now();
    const task: Task = {
      id: newId("task"),
      ticketId: ticket.id,
      projectId: project.id,
      backendId,
      worktreePath,
      branch,
      baseCommit,
      state: "running",
      attempt,
      resumeAt: null,
      startedAt: now,
      endedAt: null,
    };
    this.deps.db.insertTask(task);
    this.deps.db.updateTicket(ticket.id, { status: "in_progress" });
    this.emitTask(task);
    this.deps.bus.emit({ type: "ticket_changed", projectId: project.id, ticketId: ticket.id, at: now });

    void this.runTask(task, false).catch((e) => console.error("[chorus] runTask error:", e));
  }

  // ---- run a task (initial or resume) ----
  private async runTask(task: Task, resume: boolean): Promise<void> {
    const project = this.deps.db.getProject(task.projectId);
    const ticket = this.deps.db.getTicket(task.ticketId);
    if (!project || !ticket) return;

    // Guard against double-dispatch (e.g. a quota-resume racing the next tick):
    // reserve the slot and flip state synchronously, before any await.
    if (this.running.has(task.id)) return;
    this.running.set(task.id, { stop: async () => {} });
    this.deps.db.updateTask(task.id, { state: "running", resumeAt: null });
    this.emitTaskState(task, "running");

    const role = ticket.roleName ? this.deps.db.getRole(project.id, ticket.roleName) ?? null : null;
    const backend = this.deps.backends.get(task.backendId);
    const runId = newId("run");
    const artifactsDir = join(this.deps.config.dataDir, "runs", task.id, runId);

    const prompt = buildAgentPrompt({
      project,
      role,
      ticket,
      specExcerpt: this.readSpecExcerpt(project),
      resume,
    });

    this.deps.db.insertRun({
      id: runId,
      taskId: task.id,
      pid: null,
      pgid: null,
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      terminalReason: null,
      rawLogPath: null,
      outputFilePath: null,
    });

    const handle = backend.startRun({
      taskId: task.id,
      prompt,
      worktreePath: task.worktreePath,
      model: role?.model,
      resume,
      maxWallClockMs: this.deps.config.agent.maxWallClockMs,
      idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
      artifactsDir,
    });
    this.deps.db.updateRun(runId, { pid: handle.pid ?? null, pgid: handle.pgid ?? null });
    this.running.set(task.id, { stop: () => handle.stop("killed") });

    // Drain events for the live dashboard feed, tagged with who/what.
    const drain = (async () => {
      for await (const ev of handle.events) {
        this.deps.bus.emit({
          type: "agent_event",
          taskId: task.id,
          role: ticket.roleName,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          event: ev,
          at: Date.now(),
        });
      }
    })();

    let result: AgentResult;
    try {
      [result] = await Promise.all([handle.result, drain]);
    } catch (err) {
      this.running.delete(task.id);
      this.deps.db.updateRun(runId, { endedAt: Date.now(), terminalReason: "failed" });
      this.setTaskState(task, "failed");
      this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
      void this.notify("error", project, "Agent run errored", `${ticket.title}: ${String(err)}`).catch(() => {});
      void this.tick().catch((e) => console.error("[chorus] tick error:", e));
      return;
    }

    this.running.delete(task.id);
    this.deps.db.updateRun(runId, {
      endedAt: Date.now(),
      exitCode: result.exitCode,
      exitSignal: result.signal,
      terminalReason: result.terminalReason,
      rawLogPath: result.rawLogPath,
      outputFilePath: result.outputFilePath,
    });
    this.recordUsage(runId, project, result);

    // Done-detection + merge can touch git/db; never let a failure here escape
    // as an unhandled rejection and crash the daemon.
    try {
      await this.handleResult(project, ticket, task, runId, result);
    } catch (err) {
      this.setTaskState(task, "failed");
      this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
      void this.notify(
        "error",
        project,
        "Post-run handling failed",
        `${ticket.title}: ${String(err)}`,
      ).catch(() => {});
    }
    void this.tick().catch((e) => console.error("[chorus] tick error:", e));
  }

  // ---- done-detection & merge ----
  private async handleResult(
    project: Project,
    ticket: Ticket,
    task: Task,
    runId: string,
    result: AgentResult,
  ): Promise<void> {
    switch (result.terminalReason) {
      case "killed":
        // Deliberate stop; leave the task interrupted for later inspection.
        this.setTaskState(task, "interrupted");
        return;
      case "quota_exhausted":
        await this.pauseForQuota(project, ticket, task, runId);
        return;
      case "timeout":
      case "idle_timeout":
      case "crashed":
      case "failed":
      case "unknown":
        this.setTaskState(task, "failed");
        this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
        await this.notify("error", project, "Task failed", `${ticket.title} (${result.terminalReason})`);
        return;
      case "completed":
        break;
    }

    // Clean exit — inspect git state to decide whether to merge.
    const hasCommits = await this.deps.git.hasNewCommits(
      project.localPath,
      task.baseCommit,
      task.branch,
    );
    const clean = await this.deps.git.isWorktreeClean(task.worktreePath);

    if (!hasCommits) {
      this.setTaskState(task, "done-no-changes");
      this.deps.db.updateTicket(ticket.id, {
        status: result.payload?.status === "blocked" ? "blocked" : "needs_review",
      });
      await this.notify("needs_review", project, "No changes produced", ticket.title);
      return;
    }
    if (!clean) {
      this.setTaskState(task, "partial");
      this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
      await this.notify("needs_review", project, "Partial work (uncommitted changes)", ticket.title);
      return;
    }
    if (!result.payload) {
      // Commits exist but output is missing/invalid — let a human gate it.
      this.setTaskState(task, "done-unverified");
      this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
      await this.notify("needs_review", project, "Unverified result (review before merge)", ticket.title);
      return;
    }
    if (result.payload.status !== "success") {
      this.setTaskState(task, "partial");
      this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
      await this.notify("needs_review", project, `Agent reported ${result.payload.status}`, ticket.title);
      return;
    }

    // Eligible to merge.
    this.setTaskState(task, "done-pending-merge");
    await this.mergeTask(project, ticket, task, result);
  }

  private async mergeTask(
    project: Project,
    ticket: Ticket,
    task: Task,
    result: AgentResult,
  ): Promise<void> {
    const summary = result.payload?.summary ?? ticket.title;
    const message = `chorus: ${ticket.title}\n\n${summary}\n\nTicket: ${ticket.id}\nBranch: ${task.branch}`;
    const outcome = await this.deps.git.mergeIntoIntegration(
      project.localPath,
      project.integrationBranch,
      task.branch,
      message,
    );

    const mergeId = newId("merge");
    this.deps.db.insertMerge({
      id: mergeId,
      taskId: task.id,
      projectId: project.id,
      integrationBranch: project.integrationBranch,
      mergeCommit: outcome.mergeCommit,
      status: outcome.status,
      conflictFiles: outcome.conflictFiles,
      createdAt: Date.now(),
    });

    if (outcome.status === "conflicted") {
      this.setTaskState(task, "conflicted");
      this.deps.db.updateTicket(ticket.id, { status: "blocked" });
      this.deps.bus.emit({ type: "merge", projectId: project.id, taskId: task.id, mergeId, at: Date.now() });
      await this.notify(
        "conflict",
        project,
        "Merge conflict — human needed",
        `${ticket.title}\nConflicting files:\n${outcome.conflictFiles.join("\n")}`,
      );
      return;
    }

    // Merged. Record changelog (DB + repo), clean up worktree, notify.
    const role = ticket.roleName;
    const entry = {
      id: newId("cl"),
      projectId: project.id,
      ticketId: ticket.id,
      mergeId,
      entry: `${ticket.title} — ${summary}`,
      agentRole: role,
      createdAt: Date.now(),
    };
    this.deps.db.insertChangelog(entry);
    await this.persistChangelog(project);

    this.setTaskState(task, "merged");
    this.deps.db.updateTicket(ticket.id, { status: "merged" });
    this.deps.db.updateTask(task.id, { endedAt: Date.now() });

    try {
      await this.deps.git.removeWorktree(project.localPath, task.worktreePath);
    } catch {
      /* best-effort cleanup */
    }

    this.deps.bus.emit({ type: "merge", projectId: project.id, taskId: task.id, mergeId, at: Date.now() });
    this.deps.bus.emit({ type: "changelog", projectId: project.id, entryId: entry.id, at: Date.now() });
    await this.notify("merged", project, "Merged into integration", `${ticket.title}\n${summary}`);
  }

  private async persistChangelog(project: Project): Promise<void> {
    const entries = this.deps.db.listChangelog(project.id, 1000);
    const content = renderChangelog(entries);
    try {
      await this.deps.git.commitFile(
        project.localPath,
        "CHANGELOG.md",
        content,
        "chorus: update changelog",
        project.integrationBranch,
      );
    } catch {
      /* changelog commit failure is non-fatal */
    }
  }

  private async pauseForQuota(
    project: Project,
    ticket: Ticket,
    task: Task,
    runId: string,
  ): Promise<void> {
    const quota = this.deps.db.getQuota();
    // If a sibling agent already flagged exhaustion in this window, join its
    // backoff instead of re-incrementing the counter (concurrent agents would
    // otherwise each bump it and clobber each other's resumeAt).
    const alreadyExhausted = quota.state === "exhausted" && quota.resumeAt != null;
    const pauses = alreadyExhausted ? quota.consecutivePauses : quota.consecutivePauses + 1;
    const resumeAt = alreadyExhausted ? quota.resumeAt! : this.nextRetryAt(pauses);
    this.deps.db.setQuota({
      state: "exhausted",
      resumeAt,
      consecutivePauses: pauses,
      updatedAt: Date.now(),
    });
    this.deps.db.updateTask(task.id, { state: "paused-quota", resumeAt });
    this.emitTaskState(task, "paused-quota");
    this.deps.db.insertUsage({
      id: newId("usage"),
      runId,
      projectId: project.id,
      kind: "quota_exhausted",
      inputTokens: null,
      outputTokens: null,
      detail: `Paused; retry at ${new Date(resumeAt).toISOString()}`,
      observedAt: Date.now(),
    });
    this.deps.bus.emit({ type: "quota", state: "exhausted", resumeAt, at: Date.now() });
    await this.notify(
      "quota_paused",
      project,
      "Quota exhausted — paused",
      `${ticket.title}\nWill resume around ${new Date(resumeAt).toLocaleString()}`,
    );
  }

  private nextRetryAt(consecutivePauses: number): number {
    const { backoffStartMs, backoffMaxMs } = this.deps.config.quota;
    const factor = 2 ** Math.max(0, consecutivePauses - 1);
    return Date.now() + Math.min(backoffStartMs * factor, backoffMaxMs);
  }

  private recordUsage(runId: string, project: Project, result: AgentResult): void {
    const u = result.usage;
    if (u.inputTokens === undefined && u.outputTokens === undefined && u.totalTokens === undefined) {
      return;
    }
    this.deps.db.insertUsage({
      id: newId("usage"),
      runId,
      projectId: project.id,
      kind: "tokens",
      inputTokens: u.inputTokens ?? null,
      outputTokens: u.outputTokens ?? null,
      detail: null,
      observedAt: Date.now(),
    });
    this.deps.bus.emit({ type: "usage", projectId: project.id, at: Date.now() });
  }

  private readSpecExcerpt(project: Project): string | null {
    if (!project.specPath) return null;
    const full = join(project.localPath, project.specPath);
    if (!existsSync(full)) return null;
    try {
      return readFileSync(full, "utf8");
    } catch {
      return null;
    }
  }

  private failTicket(ticket: Ticket, reason: string): void {
    this.deps.db.updateTicket(ticket.id, { status: "needs_review" });
    const project = this.deps.db.getProject(ticket.projectId);
    if (project) void this.notify("error", project, "Dispatch failed", `${ticket.title}: ${reason}`);
  }

  private setTaskState(task: Task, state: TaskState): void {
    this.deps.db.updateTask(task.id, { state, endedAt: Date.now() });
    this.emitTaskState(task, state);
  }

  private emitTask(task: Task): void {
    this.emitTaskState(task, task.state);
  }
  private emitTaskState(task: Task, state: TaskState): void {
    this.deps.bus.emit({
      type: "task_changed",
      projectId: task.projectId,
      ticketId: task.ticketId,
      taskId: task.id,
      state,
      at: Date.now(),
    });
  }

  private async notify(
    kind: "merged" | "conflict" | "needs_review" | "quota_paused" | "error",
    project: Project,
    title: string,
    body: string,
  ): Promise<void> {
    this.deps.bus.emit({ type: "notification", kind, title, body, at: Date.now() });
    await this.deps.notifier.notify({ kind, projectId: project.id, title, body, at: Date.now() });
  }
}
