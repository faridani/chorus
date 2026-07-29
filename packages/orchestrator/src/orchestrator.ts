import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BackendRegistry } from "@chorus/backends";
import {
  type AgentEvent,
  type AgentResult,
  type ChorusBus,
  type Config,
  newId,
  type Notifier,
  ORCHESTRATOR_ROLE,
  type OrchestratorDecision,
  type OrchestratorState,
  type Project,
  type Role,
  type Task,
  type Ticket,
  type TicketEvent,
} from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";
import { renderChangelog } from "./changelog.js";
import { buildAgentPrompt, buildOrchestratorPrompt } from "./prompt.js";
import { runTriage } from "./triage.js";

export interface OrchestratorDeps {
  db: ChorusDb;
  git: GitService;
  backends: BackendRegistry;
  notifier: Notifier;
  bus: ChorusBus;
  config: Config;
}

/**
 * The daemon dispatch loop. Processes tickets serially per project through a
 * per-project "orchestrator" triage agent: every ticket flows
 * orchestrator → worker → orchestrator (keep working / merge / close) → done.
 * The orchestrator agent gates merges; workers never merge themselves.
 */
export class Orchestrator {
  private state: OrchestratorState = "stopped";
  private timer: NodeJS.Timeout | undefined;
  /** ticketId → active op (one per ticket; per-project serial). */
  private readonly active = new Map<string, { projectId: string; stop: () => Promise<void> }>();
  private ticking = false;

  constructor(private readonly deps: OrchestratorDeps) {}

  getState(): OrchestratorState {
    return this.state;
  }

  /** Ticket ids currently being acted on (used by the UI + controller guards). */
  runningTaskIds(): string[] {
    return [...this.active.keys()];
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

  async stop(): Promise<void> {
    this.setState("stopped");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await Promise.allSettled([...this.active.values()].map((h) => h.stop()));
  }

  private setState(s: OrchestratorState): void {
    this.state = s;
    this.deps.bus.emit({ type: "orchestrator_state", state: s, at: Date.now() });
  }

  /** One iteration of the dispatch loop. Serial: at most one agent per project. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (this.state !== "running") return;
      this.reconcileQuota();
      if (this.deps.db.getQuota().state === "exhausted") return;

      // Resume quota-paused worker runs (per running project, if it's idle).
      for (const task of this.deps.db.listTasksByState("paused-quota")) {
        const project = this.deps.db.getProject(task.projectId);
        if (!project || project.runState !== "running") continue;
        if (this.projectBusy(project.id)) continue;
        const ticket = this.deps.db.getTicket(task.ticketId);
        if (!ticket || this.active.has(ticket.id)) continue;
        void this.processTicket(ticket, task.id);
      }

      // Dispatch the top open ticket of each idle, running project (serial).
      for (const project of this.deps.db.listProjects()) {
        if (project.status !== "ready" || project.runState !== "running") continue;
        if (this.projectBusy(project.id)) continue;
        const ticket = this.deps.db.nextOpenTicket(project.id);
        if (!ticket) continue;
        void this.processTicket(ticket);
      }
    } finally {
      this.ticking = false;
    }
  }

  private projectBusy(projectId: string): boolean {
    for (const v of this.active.values()) if (v.projectId === projectId) return true;
    return false;
  }

  /** Stop the agent currently running for a project (Stop button). */
  async stopProjectAgents(projectId: string): Promise<void> {
    const stops: Array<Promise<void>> = [];
    for (const v of this.active.values()) if (v.projectId === projectId) stops.push(v.stop());
    await Promise.allSettled(stops);
  }

  // ---- ticket processing ----
  /** Reserve the project's serial slot, then route to orchestrator or worker. */
  private async processTicket(ticket: Ticket, resumeTaskId?: string): Promise<void> {
    if (this.active.has(ticket.id)) return;
    const project = this.deps.db.getProject(ticket.projectId);
    if (!project) return;
    this.active.set(ticket.id, { projectId: project.id, stop: async () => {} });
    this.deps.db.updateTicket(ticket.id, { status: "in_progress" });
    this.emitTicket(project.id, ticket.id);

    try {
      const isOrchestrator = !ticket.roleName || ticket.roleName === ORCHESTRATOR_ROLE;
      if (isOrchestrator) {
        await this.runOrchestratorDecision(project, ticket);
      } else {
        await this.runWorker(project, ticket, resumeTaskId);
      }
    } catch (err) {
      this.trail(project.id, ticket.id, "system", "note", `Processing error: ${String(err)}`);
      this.handBackToOrchestrator(project.id, ticket.id);
      void this.notify("error", project, "Processing error", `${ticket.title}: ${String(err)}`).catch(() => {});
    } finally {
      this.active.delete(ticket.id);
      void this.tick().catch((e) => console.error("[chorus] tick error:", e));
    }
  }

  // ---- orchestrator (triage / review) ----
  private async runOrchestratorDecision(project: Project, ticket: Ticket): Promise<void> {
    const workers = this.deps.db
      .listRoles(project.id)
      .filter((r) => r.name !== ORCHESTRATOR_ROLE);
    const orchRole = this.deps.db.getRole(project.id, ORCHESTRATOR_ROLE);
    const attempt = this.workerAttempts(ticket.id);

    let workSummaryText: string | null = null;
    if (ticket.branch) {
      const { commits, files } = await this.deps.git.branchSummary(
        project.localPath,
        project.integrationBranch,
        ticket.branch,
      );
      workSummaryText =
        commits.length === 0
          ? "Branch exists but has no commits beyond the integration branch."
          : `Commits:\n${commits.map((c) => `  - ${c}`).join("\n")}\nFiles changed:\n${files.map((f) => `  - ${f}`).join("\n")}`;
    }

    const prompt = buildOrchestratorPrompt({
      project,
      ticket,
      trail: this.deps.db.listTicketEvents(ticket.id),
      workers,
      workSummary: workSummaryText,
      attempt,
      maxAttempts: this.deps.config.maxAttemptsPerTicket,
    });

    this.emitAgentEvent(project.id, ticket, ORCHESTRATOR_ROLE, {
      kind: "message",
      text: "Orchestrator is reviewing the ticket…",
      at: Date.now(),
    });

    const cwd =
      ticket.worktreePath && existsSync(ticket.worktreePath) ? ticket.worktreePath : project.localPath;
    const artifactsDir = join(this.deps.config.dataDir, "triage", ticket.id, newId("t"));

    let decision: OrchestratorDecision;
    try {
      decision = await runTriage({
        cwd,
        artifactsDir,
        prompt,
        model: orchRole?.model,
        maxWallClockMs: this.deps.config.agent.maxWallClockMs,
        idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
        onEvent: (ev) => this.emitAgentEvent(project.id, ticket, ORCHESTRATOR_ROLE, ev),
      });
    } catch (err) {
      if (this.looksLikeQuota(String(err))) {
        this.enterQuotaBackoff();
        // Leave the ticket open & assigned to the orchestrator; retried after backoff.
        this.deps.db.updateTicket(ticket.id, { status: "open", roleName: ORCHESTRATOR_ROLE });
        return;
      }
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "note", `Triage failed: ${String(err)}`);
      this.blockTicket(project, ticket, `Orchestrator could not triage this ticket: ${String(err)}`);
      return;
    }

    this.emitAgentEvent(project.id, ticket, ORCHESTRATOR_ROLE, {
      kind: "message",
      text: `${decision.action.toUpperCase()}: ${decision.message}`,
      at: Date.now(),
    });
    this.trail(
      project.id,
      ticket.id,
      ORCHESTRATOR_ROLE,
      "triage",
      `${decision.action.toUpperCase()} — ${decision.message}`,
    );

    // Side effects allowed alongside any action.
    for (const s of decision.suggestions ?? []) this.addSuggestion(project, ticket.id, s);
    for (const nt of decision.newTickets ?? []) this.createFollowUpTicket(project.id, nt);

    await this.applyDecision(project, ticket, decision, workers);
  }

  private async applyDecision(
    project: Project,
    ticket: Ticket,
    decision: OrchestratorDecision,
    workers: Role[],
  ): Promise<void> {
    switch (decision.action) {
      case "assign": {
        const target = workers.find((w) => w.name === decision.assignee);
        if (!target) {
          this.addSuggestion(
            project,
            ticket.id,
            `Orchestrator wanted to assign to "${decision.assignee}", which is not an agent in this project. Add it (Agents tab / Gallery) or adjust.`,
          );
          this.blockTicket(project, ticket, `No such agent: ${decision.assignee}`);
          return;
        }
        this.deps.db.updateTicket(ticket.id, {
          status: "open",
          roleName: target.name,
          priority: decision.priority ?? ticket.priority,
        });
        this.emitTicket(project.id, ticket.id);
        return;
      }
      case "merge":
        await this.mergeTicket(project, ticket);
        return;
      case "close":
        await this.closeTicket(project, ticket, "closed");
        return;
      case "needs_human":
        this.blockTicket(project, ticket, decision.message);
        return;
    }
  }

  // ---- worker run ----
  private async runWorker(project: Project, ticket: Ticket, resumeTaskId?: string): Promise<void> {
    const role = ticket.roleName ? this.deps.db.getRole(project.id, ticket.roleName) ?? null : null;
    if (!role) {
      this.trail(project.id, ticket.id, "system", "note", `Assigned agent "${ticket.roleName}" no longer exists.`);
      this.handBackToOrchestrator(project.id, ticket.id);
      return;
    }
    if (this.workerAttempts(ticket.id) >= this.deps.config.maxAttemptsPerTicket) {
      this.addSuggestion(project, ticket.id, `Ticket reached ${this.deps.config.maxAttemptsPerTicket} worker attempts without completion.`);
      this.blockTicket(project, ticket, "Max worker attempts reached.");
      return;
    }

    // Ensure a persistent per-ticket branch/worktree; resume if it already exists.
    const resume = !!ticket.branch;
    let branch = ticket.branch ?? `chorus/ticket-${ticket.id}`;
    let worktreePath =
      ticket.worktreePath ?? join(this.deps.config.dataDir, "worktrees", project.id, ticket.id);
    let baseCommit: string;
    try {
      baseCommit = await this.deps.git.headCommit(project.localPath, project.integrationBranch);
      if (!resume) {
        await this.deps.git.addWorktree(project.localPath, worktreePath, branch, project.integrationBranch);
        this.deps.db.updateTicket(ticket.id, { branch, worktreePath });
      }
    } catch (err) {
      this.trail(project.id, ticket.id, role.name, "note", `Failed to prepare worktree: ${String(err)}`);
      this.handBackToOrchestrator(project.id, ticket.id);
      return;
    }

    const backend = this.deps.backends.has(role.backendId)
      ? this.deps.backends.get(role.backendId)
      : this.deps.backends.get("codex");
    const runId = newId("run");
    const taskId = resumeTaskId ?? newId("task");
    const now = Date.now();
    if (resumeTaskId) {
      this.deps.db.updateTask(taskId, { state: "running", resumeAt: null });
    } else {
      const task: Task = {
        id: taskId,
        ticketId: ticket.id,
        projectId: project.id,
        backendId: role.backendId,
        worktreePath,
        branch,
        baseCommit,
        state: "running",
        attempt: this.workerAttempts(ticket.id) + 1,
        resumeAt: null,
        startedAt: now,
        endedAt: null,
      };
      this.deps.db.insertTask(task);
    }
    this.deps.db.insertRun({
      id: runId,
      taskId,
      pid: null,
      pgid: null,
      startedAt: now,
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      terminalReason: null,
      rawLogPath: null,
      outputFilePath: null,
    });

    const prompt = buildAgentPrompt({
      project,
      role,
      ticket,
      specExcerpt: this.readSpecExcerpt(project),
      resume,
    });
    const handle = backend.startRun({
      taskId,
      prompt,
      worktreePath,
      model: role.model,
      resume,
      maxWallClockMs: this.deps.config.agent.maxWallClockMs,
      idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
      artifactsDir: join(this.deps.config.dataDir, "runs", taskId, runId),
    });
    this.deps.db.updateRun(runId, { pid: handle.pid ?? null, pgid: handle.pgid ?? null });
    const slot = this.active.get(ticket.id);
    if (slot) slot.stop = () => handle.stop("killed");

    const drain = (async () => {
      for await (const ev of handle.events) {
        this.deps.bus.emit({
          type: "agent_event",
          projectId: project.id,
          taskId,
          role: role.name,
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
      this.deps.db.updateTask(taskId, { state: "failed", endedAt: Date.now() });
      this.deps.db.updateRun(runId, { endedAt: Date.now(), terminalReason: "failed" });
      this.trail(project.id, ticket.id, role.name, "work", `Run errored: ${String(err)}`);
      this.handBackToOrchestrator(project.id, ticket.id);
      return;
    }

    this.deps.db.updateRun(runId, {
      endedAt: Date.now(),
      exitCode: result.exitCode,
      exitSignal: result.signal,
      terminalReason: result.terminalReason,
      rawLogPath: result.rawLogPath,
      outputFilePath: result.outputFilePath,
    });
    this.recordUsage(runId, project, result);

    if (result.terminalReason === "quota_exhausted") {
      await this.pauseForQuota(project, ticket, taskId, runId);
      return; // ticket stays in_progress; resume loop re-runs the worker
    }

    // Any other terminal outcome: record the worker's result and hand back to
    // the orchestrator, which decides whether to merge / keep working / close.
    const summary = result.payload?.summary ?? `(${result.terminalReason})`;
    this.deps.db.updateTask(taskId, { state: "done-pending-merge", endedAt: Date.now() });
    this.trail(
      project.id,
      ticket.id,
      role.name,
      "work",
      result.payload
        ? `${result.payload.status}: ${summary}` +
            (result.payload.filesChanged?.length ? ` (files: ${result.payload.filesChanged.join(", ")})` : "")
        : `Ended (${result.terminalReason}).`,
    );
    this.handBackToOrchestrator(project.id, ticket.id);
  }

  // ---- terminal ticket actions ----
  private async mergeTicket(project: Project, ticket: Ticket): Promise<void> {
    if (!ticket.branch) {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "merge", "Nothing to merge; closing.");
      await this.closeTicket(project, ticket, "closed");
      return;
    }
    const hasCommits = await this.deps.git.hasNewCommits(
      project.localPath,
      project.integrationBranch,
      ticket.branch,
    );
    if (!hasCommits) {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "merge", "No commits to merge; closing.");
      await this.closeTicket(project, ticket, "closed");
      return;
    }

    const outcome = await this.deps.git.mergeIntoIntegration(
      project.localPath,
      project.integrationBranch,
      ticket.branch,
      `chorus: ${ticket.title}\n\nTicket: ${ticket.id}`,
    );
    const mergeId = newId("merge");
    this.deps.db.insertMerge({
      id: mergeId,
      taskId: ticket.id,
      projectId: project.id,
      integrationBranch: project.integrationBranch,
      mergeCommit: outcome.mergeCommit,
      status: outcome.status,
      conflictFiles: outcome.conflictFiles,
      createdAt: Date.now(),
    });
    this.deps.bus.emit({ type: "merge", projectId: project.id, taskId: ticket.id, mergeId, at: Date.now() });

    if (outcome.status === "conflicted") {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "merge", `Merge conflict: ${outcome.conflictFiles.join(", ")}`);
      this.blockTicket(project, ticket, `Merge conflict in: ${outcome.conflictFiles.join(", ")}`);
      return;
    }

    const entry = {
      id: newId("cl"),
      projectId: project.id,
      ticketId: ticket.id,
      mergeId,
      entry: ticket.title,
      agentRole: ORCHESTRATOR_ROLE,
      createdAt: Date.now(),
    };
    this.deps.db.insertChangelog(entry);
    await this.persistChangelog(project);
    this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "merge", `Merged into ${project.integrationBranch} (${outcome.mergeCommit?.slice(0, 8)}).`);
    await this.cleanupWorktree(project, ticket);
    this.deps.db.updateTicket(ticket.id, { status: "merged", branch: null, worktreePath: null });
    this.emitTicket(project.id, ticket.id);
    this.deps.bus.emit({ type: "changelog", projectId: project.id, entryId: entry.id, at: Date.now() });
    await this.notify("merged", project, "Merged into integration", ticket.title);
  }

  private async closeTicket(project: Project, ticket: Ticket, status: "closed"): Promise<void> {
    this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "close", "Ticket closed by the orchestrator.");
    await this.cleanupWorktree(project, ticket);
    this.deps.db.updateTicket(ticket.id, { status, branch: null, worktreePath: null });
    this.emitTicket(project.id, ticket.id);
  }

  private blockTicket(project: Project, ticket: Ticket, reason: string): void {
    this.deps.db.updateTicket(ticket.id, { status: "blocked" });
    this.emitTicket(project.id, ticket.id);
    void this.notify("needs_review", project, "Needs human", `${ticket.title}\n${reason}`).catch(() => {});
  }

  private handBackToOrchestrator(projectId: string, ticketId: string): void {
    this.deps.db.updateTicket(ticketId, { status: "open", roleName: ORCHESTRATOR_ROLE });
    this.emitTicket(projectId, ticketId);
  }

  private async cleanupWorktree(project: Project, ticket: Ticket): Promise<void> {
    if (!ticket.worktreePath) return;
    try {
      await this.deps.git.removeWorktree(project.localPath, ticket.worktreePath);
    } catch {
      /* best-effort */
    }
  }

  private createFollowUpTicket(projectId: string, t: { title: string; body: string; priority?: number }): void {
    const now = Date.now();
    const id = newId("tkt");
    this.deps.db.insertTicket({
      id,
      projectId,
      title: t.title,
      body: t.body,
      status: "open",
      roleName: ORCHESTRATOR_ROLE,
      priority: t.priority ?? 0,
      source: "manual",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    });
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId: id, at: now });
  }

  private addSuggestion(project: Project, ticketId: string | null, message: string): void {
    const s = {
      id: newId("sug"),
      projectId: project.id,
      ticketId,
      message,
      status: "open" as const,
      createdAt: Date.now(),
    };
    this.deps.db.insertSuggestion(s);
    this.deps.bus.emit({ type: "project_changed", projectId: project.id, at: Date.now() });
    void this.notify("needs_review", project, "Orchestrator suggestion", message).catch(() => {});
  }

  // ---- trail / events ----
  private trail(
    projectId: string,
    ticketId: string,
    actor: string,
    kind: TicketEvent["kind"],
    message: string,
  ): void {
    this.deps.db.insertTicketEvent({
      id: newId("te"),
      projectId,
      ticketId,
      actor,
      kind,
      message,
      createdAt: Date.now(),
    });
    this.emitTicket(projectId, ticketId);
  }

  private emitTicket(projectId: string, ticketId: string): void {
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
  }

  private emitAgentEvent(projectId: string, ticket: Ticket, role: string, event: AgentEvent): void {
    this.deps.bus.emit({
      type: "agent_event",
      projectId,
      taskId: ticket.id,
      role,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      event,
      at: Date.now(),
    });
  }

  // ---- quota ----
  private reconcileQuota(): void {
    const quota = this.deps.db.getQuota();
    if (quota.state === "exhausted" && quota.resumeAt && quota.resumeAt <= Date.now()) {
      this.deps.db.setQuota({ ...quota, state: "available", resumeAt: null });
      this.deps.bus.emit({ type: "quota", state: "available", resumeAt: null, at: Date.now() });
    }
  }

  private enterQuotaBackoff(): void {
    const quota = this.deps.db.getQuota();
    if (quota.state === "exhausted" && quota.resumeAt) return;
    const pauses = quota.consecutivePauses + 1;
    const resumeAt = this.nextRetryAt(pauses);
    this.deps.db.setQuota({ state: "exhausted", resumeAt, consecutivePauses: pauses, updatedAt: Date.now() });
    this.deps.bus.emit({ type: "quota", state: "exhausted", resumeAt, at: Date.now() });
  }

  private looksLikeQuota(text: string): boolean {
    return this.deps.config.quota.exhaustionPatterns.some((p) => new RegExp(p, "i").test(text));
  }

  private async pauseForQuota(
    project: Project,
    ticket: Ticket,
    taskId: string,
    runId: string,
  ): Promise<void> {
    const quota = this.deps.db.getQuota();
    const alreadyExhausted = quota.state === "exhausted" && quota.resumeAt != null;
    const pauses = alreadyExhausted ? quota.consecutivePauses : quota.consecutivePauses + 1;
    const resumeAt = alreadyExhausted ? quota.resumeAt! : this.nextRetryAt(pauses);
    this.deps.db.setQuota({ state: "exhausted", resumeAt, consecutivePauses: pauses, updatedAt: Date.now() });
    this.deps.db.updateTask(taskId, { state: "paused-quota", resumeAt });
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
    await this.notify("quota_paused", project, "Quota exhausted — paused", ticket.title);
  }

  private nextRetryAt(consecutivePauses: number): number {
    const { backoffStartMs, backoffMaxMs } = this.deps.config.quota;
    const factor = 2 ** Math.max(0, consecutivePauses - 1);
    return Date.now() + Math.min(backoffStartMs * factor, backoffMaxMs);
  }

  // ---- helpers ----
  private workerAttempts(ticketId: string): number {
    return this.deps.db.listTasksForTicket(ticketId).length;
  }

  private recordUsage(runId: string, project: Project, result: AgentResult): void {
    const u = result.usage;
    if (u.inputTokens === undefined && u.outputTokens === undefined && u.totalTokens === undefined) return;
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

  private async persistChangelog(project: Project): Promise<void> {
    const content = renderChangelog(this.deps.db.listChangelog(project.id, 1000));
    try {
      await this.deps.git.commitFile(
        project.localPath,
        "CHANGELOG.md",
        content,
        "chorus: update changelog",
        project.integrationBranch,
      );
    } catch {
      /* non-fatal */
    }
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

  private async notify(
    kind: "merged" | "conflict" | "needs_review" | "quota_paused" | "error",
    project: Project,
    title: string,
    body: string,
  ): Promise<void> {
    this.deps.bus.emit({ type: "notification", projectId: project.id, kind, title, body, at: Date.now() });
    await this.deps.notifier.notify({ kind, projectId: project.id, title, body, at: Date.now() });
  }
}
