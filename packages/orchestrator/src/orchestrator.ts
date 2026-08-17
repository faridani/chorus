import { createHash } from "node:crypto";
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
import { runShell } from "@chorus/proc";
import { type EvaluatorVerdict, runEvaluator } from "./evaluate.js";
import { buildManifest, type TaskManifest } from "./manifest.js";
import { buildAgentPrompt, buildOrchestratorPrompt } from "./prompt.js";
import { type ReviewerVerdict, runReviewer } from "./review.js";
import { EVIDENCE_SCOPE_RULE, PROSE_NARRATION_RULE, READ_ONLY_RULE } from "./structured-run.js";
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
 * orchestrator → worker → orchestrator (keep working / open PR / close) → done.
 * The orchestrator agent gates PRs; workers never push or open PRs themselves.
 */
export class Orchestrator {
  private state: OrchestratorState = "stopped";
  private timer: NodeJS.Timeout | undefined;
  /** ticketId → active op (one per ticket; per-project serial). */
  private readonly active = new Map<string, { projectId: string; stop: () => Promise<void> }>();
  private ticking = false;
  /** Last time open PRs were polled for merge (throttles the gh calls). */
  private lastPrPollAt = 0;
  /** How often to poll GitHub for PR merge state (ms). */
  private static readonly PR_POLL_INTERVAL_MS = 30_000;
  /** ticketId → the most recent worker attempt's metadata (for the journal). */
  private readonly lastAttempt = new Map<string, { taskId: string; attempt: number; promptHash: string }>();
  /** Tickets a human just reopened: re-attempt the PR rather than re-triaging stale failures. */
  private readonly reattemptPr = new Set<string>();
  /** ticketId → consecutive gate interruptions for a given worker attempt (resets when a new attempt runs). */
  private readonly gateRetries = new Map<string, { attempt: number; retries: number }>();
  /** Max consecutive gate interruptions before parking the ticket for a human. */
  private static readonly MAX_GATE_RETRIES = 3;

  constructor(private readonly deps: OrchestratorDeps) {}

  /**
   * Mark a ticket (just reopened by a human) to re-attempt the PR on its next
   * pass. A ticket parked for an *environmental* blocker (failed push, broken
   * hook, tooling error) otherwise re-triages against a failure-heavy trail and
   * re-parks itself without retrying — so reopening alone never unsticks it once
   * the environment is fixed. This makes reopen deterministically re-run the
   * gate + PR path instead.
   */
  requestReattempt(ticketId: string): void {
    this.reattemptPr.add(ticketId);
  }

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

      // Poll open PRs for merge (throttled) regardless of quota — read-only.
      if (Date.now() - this.lastPrPollAt >= Orchestrator.PR_POLL_INTERVAL_MS) {
        this.lastPrPollAt = Date.now();
        await this.pollOpenPrs().catch((e) => console.error("[chorus] PR poll error:", e));
      }

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
    // A human just reopened this ticket and it has committed work: re-attempt
    // the PR path directly. This bypasses LLM triage (which would re-read the
    // failure-heavy trail and re-park an environmentally-blocked ticket without
    // retrying). finishTicket re-runs the gate, so incomplete work still loops
    // back to a worker; a now-resolved environmental blocker lets the PR open.
    if (this.reattemptPr.delete(ticket.id) && ticket.branch) {
      const hasCommits = await this.deps.git
        .hasNewCommits(project.localPath, this.baseRef(project), ticket.branch)
        .catch(() => false);
      if (hasCommits) {
        this.trail(
          project.id,
          ticket.id,
          ORCHESTRATOR_ROLE,
          "triage",
          "Reopened — re-attempting the PR (a prior environmental blocker may now be resolved).",
        );
        await this.finishTicket(project, ticket);
        return;
      }
    }

    const workers = this.deps.db
      .listRoles(project.id)
      .filter((r) => r.name !== ORCHESTRATOR_ROLE);
    const orchRole = this.deps.db.getRole(project.id, ORCHESTRATOR_ROLE);
    const attempt = this.workerAttempts(ticket.id);

    let workSummaryText: string | null = null;
    if (ticket.branch) {
      const { commits, files } = await this.deps.git.branchSummary(
        project.localPath,
        this.baseRef(project),
        ticket.branch,
      );
      workSummaryText =
        commits.length === 0
          ? "Branch exists but has no commits beyond the base branch."
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
      orchestratorRole: orchRole,
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
        onStart: (stop) => {
          const slot = this.active.get(ticket.id);
          if (slot) slot.stop = stop; // make triage cancelable on Stop/shutdown
        },
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
      case "open_pr":
        await this.finishTicket(project, ticket);
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
      if (!resume) {
        await this.deps.git.addWorktree(project.localPath, worktreePath, branch, project.baseBranch);
        this.deps.db.updateTicket(ticket.id, { branch, worktreePath });
        // Make the worktree runnable so the agent can build/test/verify. A fresh
        // worktree has no node_modules (git worktrees don't share the main
        // clone's), so without this the agent can't run anything.
        await this.runSetup(project, ticket, worktreePath);
      } else if (this.needsSetup(project, worktreePath)) {
        // Resuming into a worktree that predates a setup command (e.g. the
        // command was backfilled after the worktree was created) — install deps
        // now so the verify gate doesn't run against a worktree with no deps.
        await this.runSetup(project, ticket, worktreePath);
      }
      baseCommit = await this.deps.git.headCommit(project.localPath, this.baseRef(project));
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

    // Snapshot the branch state so we can tell if this run produces NEW work
    // and feed a structured manifest (commands, criteria, prior failures) to the agent.
    const branchState = await this.deps.git
      .branchSummary(project.localPath, this.baseRef(project), branch)
      .catch(() => ({ commits: [] as string[], files: [] as string[] }));
    const commitsBefore = branchState.commits.length;
    const attemptNo = this.workerAttempts(ticket.id);
    const manifest = buildManifest({
      project,
      ticket,
      attempt: attemptNo,
      branch: branchState,
      trail: this.deps.db.listTicketEvents(ticket.id),
      latestJournal: this.deps.db.latestAttemptJournal(ticket.id),
      artifactsDir: join(this.deps.config.dataDir, "runs", taskId, runId),
    });

    const prompt = buildAgentPrompt({
      project,
      role,
      ticket,
      specExcerpt: this.readSpecExcerpt(project),
      resume,
      trail: this.deps.db.listTicketEvents(ticket.id),
      manifest,
    });
    this.lastAttempt.set(ticket.id, {
      taskId,
      attempt: attemptNo,
      promptHash: createHash("sha256").update(prompt).digest("hex").slice(0, 16),
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
    const commitsAfter = (
      await this.deps.git.branchSummary(project.localPath, this.baseRef(project), branch).catch(() => ({
        commits: [],
      }))
    ).commits.length;
    const noNewWork = commitsAfter <= commitsBefore;
    this.deps.db.updateTask(taskId, { state: "done-pending-merge", endedAt: Date.now() });
    this.trail(
      project.id,
      ticket.id,
      role.name,
      "work",
      result.payload
        ? `${result.payload.status}: ${summary}` +
            (result.payload.filesChanged?.length ? ` (files: ${result.payload.filesChanged.join(", ")})` : "") +
            (noNewWork ? " [no new commits this attempt]" : "")
        : `Ended (${result.terminalReason}).`,
    );
    this.handBackToOrchestrator(project.id, ticket.id);
  }

  // ---- acceptance gate + terminal ticket actions ----
  /**
   * The acceptance gate. The orchestrator decided the work looks ready; before
   * opening a PR we (1) run the project's verify commands programmatically
   * (deterministic backstop + evidence), (2) run the evaluator agent (runs the
   * commands + checks acceptance criteria), and (3) run the reviewer agent
   * (judges the diff). All three must pass. Every attempt is journaled. On
   * failure the ticket goes back to the worker with the diagnosis; on success a
   * PR is opened with a rich, reviewable body.
   */
  private async finishTicket(project: Project, ticket: Ticket): Promise<void> {
    if (!ticket.branch) {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "pr", "Nothing to open a PR for; closing.");
      await this.closeTicket(project, ticket, "closed");
      return;
    }
    if (!(await this.deps.git.hasNewCommits(project.localPath, this.baseRef(project), ticket.branch))) {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "pr", "No commits to open a PR for; closing.");
      await this.closeTicket(project, ticket, "closed");
      return;
    }

    const wt =
      ticket.worktreePath && existsSync(ticket.worktreePath) ? ticket.worktreePath : null;
    const meta = this.lastAttempt.get(ticket.id);
    const taskId = meta?.taskId ?? this.deps.db.listTasksForTicket(ticket.id).at(-1)?.id ?? null;
    const attempt = meta?.attempt ?? this.workerAttempts(ticket.id);
    const artifactsDir = join(this.deps.config.dataDir, "gate", ticket.id, newId("g"));

    // 1) deterministic verify
    const verify = await this.runVerify(project, wt);

    // 2) evaluator agent (must be able to run commands → needs the worktree)
    let evaluator: EvaluatorVerdict | null = null;
    let evaluatorError: string | null = null;
    if (wt) {
      try {
        evaluator = await runEvaluator({
          cwd: wt,
          artifactsDir,
          prompt: this.buildEvaluatorPrompt(project, ticket, verify),
          maxWallClockMs: this.deps.config.agent.maxWallClockMs,
          idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
          onEvent: (ev) => this.emitAgentEvent(project.id, ticket, "evaluator", ev),
          onStart: (stop) => {
            const slot = this.active.get(ticket.id);
            if (slot) slot.stop = stop;
          },
        });
      } catch (err) {
        if (this.looksLikeQuota(String(err))) {
          this.enterQuotaBackoff();
          this.deps.db.updateTicket(ticket.id, { status: "open", roleName: ORCHESTRATOR_ROLE });
          return;
        }
        // A non-quota crash must NOT be treated as approval — record it as a
        // failure so the gate doesn't silently pass.
        evaluatorError = String(err);
        this.trail(project.id, ticket.id, "evaluator", "note", `Evaluator failed: ${evaluatorError}`);
      }
    }

    // 3) reviewer agent (read-only; can run in the worktree or the main clone)
    let reviewer: ReviewerVerdict | null = null;
    let reviewerError: string | null = null;
    try {
      reviewer = await runReviewer({
        cwd: wt ?? project.localPath,
        artifactsDir,
        prompt: this.buildReviewerPrompt(project, ticket),
        maxWallClockMs: this.deps.config.agent.maxWallClockMs,
        idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
        onEvent: (ev) => this.emitAgentEvent(project.id, ticket, "reviewer", ev),
        onStart: (stop) => {
          const slot = this.active.get(ticket.id);
          if (slot) slot.stop = stop;
        },
      });
    } catch (err) {
      if (this.looksLikeQuota(String(err))) {
        this.enterQuotaBackoff();
        this.deps.db.updateTicket(ticket.id, { status: "open", roleName: ORCHESTRATOR_ROLE });
        return;
      }
      reviewerError = String(err);
      this.trail(project.id, ticket.id, "reviewer", "note", `Reviewer failed: ${reviewerError}`);
    }

    const diff = await this.deps.git.diff(project.localPath, this.baseRef(project), ticket.branch).catch(() => "");
    const diffHash = diff ? createHash("sha256").update(diff).digest("hex").slice(0, 16) : null;

    // Distinguish a genuine REJECTION (verify failed, or an agent verdict said
    // not-passed/not-approved — the work needs changes) from an INTERRUPTION (a
    // gate agent was killed/errored — e.g. a daemon restart or project stop mid-
    // run). An interruption must NOT send the worker to redo passing work; it
    // should just re-run the gate.
    const verifyFailed = verify.ran && !verify.passed;
    const evalRejected = evaluator !== null && !evaluator.passed;
    const reviewRejected = reviewer !== null && !reviewer.approved;
    const rejected = verifyFailed || evalRejected || reviewRejected;
    const interrupted = evaluatorError !== null || reviewerError !== null;

    const rejectionParts: string[] = [];
    if (verifyFailed) rejectionParts.push(`Verify commands failed:\n${verify.output.slice(-1500)}`);
    if (evalRejected) rejectionParts.push(evaluator?.diagnosis || (evaluator?.failures ?? []).join("; "));
    if (reviewRejected)
      rejectionParts.push(`Reviewer did not approve. Risks: ${(reviewer?.risks ?? []).join("; ") || "—"}`);
    const interruptParts: string[] = [];
    if (evaluatorError) interruptParts.push(`Evaluator interrupted: ${evaluatorError}`);
    if (reviewerError) interruptParts.push(`Reviewer interrupted: ${reviewerError}`);
    const fullDiagnosis = [...rejectionParts, ...interruptParts].filter(Boolean).join("\n\n") || null;

    const journal = (nextAction: string, proof: string | null) =>
      this.writeJournal({
        taskId, ticket, project, attempt, promptHash: meta?.promptHash ?? null, diffHash,
        verify, diagnosis: fullDiagnosis, nextAction, evaluator, reviewer, proof,
      });

    // Accepted: verify passed and every gate stage that ran approved (no rejection,
    // no interruption).
    if (!rejected && !interrupted) {
      this.gateRetries.delete(ticket.id);
      const prUrl = await this.openPrForTicket(project, ticket, { taskId, verify, reviewer });
      journal("open_pr", prUrl ?? "checks passed");
      return;
    }

    // A real rejection takes precedence over an interruption: the work needs
    // changes, so hand it back to the worker with the rejection diagnosis.
    if (rejected) {
      this.gateRetries.delete(ticket.id);
      journal("reassign-to-worker", null);
      this.reassignWithFeedback(
        project,
        ticket,
        rejectionParts.filter(Boolean).join("\n\n") ||
          "Verification/review did not pass; address the issues and re-verify before finishing.",
      );
      return;
    }

    // Interruption only (a gate agent was killed/errored, but verify passed and
    // nothing was rejected): re-run the GATE — do NOT redo the implementation.
    // Bounded so a persistent kill source can't loop forever.
    // Count interruptions per worker attempt: a new attempt (work changed) resets it.
    const prev = this.gateRetries.get(ticket.id);
    const retries = prev && prev.attempt === attempt ? prev.retries + 1 : 1;
    if (retries > Orchestrator.MAX_GATE_RETRIES) {
      this.gateRetries.delete(ticket.id);
      journal("blocked", null);
      this.blockTicket(
        project,
        ticket,
        `Acceptance gate kept getting interrupted (${Orchestrator.MAX_GATE_RETRIES}× — e.g. restarts/stops mid-review). Last: ${fullDiagnosis ?? "unknown"}`,
      );
      return;
    }
    this.gateRetries.set(ticket.id, { attempt, retries });
    journal("retry-gate", null);
    this.trail(
      project.id,
      ticket.id,
      ORCHESTRATOR_ROLE,
      "note",
      `Gate interrupted (try ${retries}/${Orchestrator.MAX_GATE_RETRIES}); committed work passed verify — re-running the review, not redoing the work.`,
    );
    this.requestReattempt(ticket.id);
    this.handBackToOrchestrator(project.id, ticket.id);
  }

  /** Run the project's verify commands in the worktree (stop at first failure). */
  private async runVerify(
    project: Project,
    worktreePath: string | null,
  ): Promise<{ ran: boolean; passed: boolean; results: { cmd: string; ok: boolean }[]; output: string }> {
    const cmds = (project.verifyCommands ?? []).filter((c) => c.trim());
    if (!worktreePath || cmds.length === 0) return { ran: false, passed: true, results: [], output: "" };
    const results: { cmd: string; ok: boolean }[] = [];
    const chunks: string[] = [];
    let passed = true;
    for (const cmd of cmds) {
      const r = await runShell(cmd, worktreePath, { timeoutMs: this.deps.config.agent.maxWallClockMs });
      results.push({ cmd, ok: r.ok });
      chunks.push(`$ ${cmd}\n[${r.ok ? "ok" : "FAIL"}]\n${r.combined}`);
      if (!r.ok) {
        passed = false;
        break; // first failure is the actionable one
      }
    }
    return { ran: true, passed, results, output: chunks.join("\n\n").slice(-6000) };
  }

  /**
   * Whether a resumed worktree still needs setup run: there's a setup command,
   * the worktree exists, but its `node_modules` is absent (e.g. the command was
   * backfilled after this worktree was created). Heuristic but npm-shaped, which
   * matches the detected setup commands.
   */
  private needsSetup(project: Project, worktreePath: string): boolean {
    if (!project.setupCommand?.trim()) return false;
    if (!existsSync(worktreePath)) return false;
    return !existsSync(join(worktreePath, "node_modules"));
  }

  /** One-time per-branch dependency/setup so the agent can actually build & test. */
  private async runSetup(project: Project, ticket: Ticket, worktreePath: string): Promise<void> {
    const cmd = project.setupCommand?.trim();
    if (!cmd) return;
    const r = await runShell(cmd, worktreePath, { timeoutMs: 20 * 60 * 1000 });
    this.trail(
      project.id,
      ticket.id,
      "system",
      "note",
      r.ok ? `Setup ok: \`${cmd}\`` : `Setup FAILED: \`${cmd}\`\n${r.combined.slice(-1000)}`,
    );
  }

  /** Re-route a ticket to the worker that last touched it, with feedback to act on. */
  private reassignWithFeedback(project: Project, ticket: Ticket, feedback: string): void {
    const lastWorker = [...this.deps.db.listTicketEvents(ticket.id)]
      .reverse()
      .find((e) => e.kind === "work")?.actor;
    const role = lastWorker ? this.deps.db.getRole(project.id, lastWorker) : undefined;
    this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "triage", feedback);
    this.deps.db.updateTicket(ticket.id, {
      status: "open",
      roleName: role ? role.name : ORCHESTRATOR_ROLE,
    });
    this.emitTicket(project.id, ticket.id);
  }

  private writeJournal(args: {
    taskId: string | null;
    ticket: Ticket;
    project: Project;
    attempt: number;
    promptHash: string | null;
    diffHash: string | null;
    verify: { ran: boolean; passed: boolean; output: string };
    diagnosis: string | null;
    nextAction: string;
    evaluator: EvaluatorVerdict | null;
    reviewer: ReviewerVerdict | null;
    proof: string | null;
  }): void {
    this.deps.db.insertAttemptJournal({
      id: newId("aj"),
      taskId: args.taskId ?? "unknown",
      ticketId: args.ticket.id,
      projectId: args.project.id,
      attempt: args.attempt,
      promptHash: args.promptHash,
      diffHash: args.diffHash,
      verifyPassed: args.verify.ran ? args.verify.passed : null,
      verifyOutput: args.verify.output || null,
      diagnosis: args.diagnosis,
      nextAction: args.nextAction,
      evaluatorVerdict: args.evaluator ? JSON.stringify(args.evaluator) : null,
      reviewerVerdict: args.reviewer ? JSON.stringify(args.reviewer) : null,
      proof: args.proof,
      createdAt: Date.now(),
    });
  }

  private buildEvaluatorPrompt(
    project: Project,
    ticket: Ticket,
    verify: { ran: boolean; passed: boolean; output: string },
  ): string {
    const cmds = (project.verifyCommands ?? []).filter((c) => c.trim());
    const L: string[] = [];
    L.push("# You are the EVALUATOR agent");
    L.push("Verify that the committed work in this worktree satisfies the ticket. Do not write code.");
    L.push("");
    L.push("## Ticket");
    L.push(`${ticket.title}`);
    L.push(ticket.body);
    L.push("");
    if (verify.ran) {
      // Chorus already ran the verify commands deterministically; that output is
      // authoritative. Do NOT re-run them (it just doubles slow build/test time
      // and widens the window where a restart can interrupt this run).
      L.push("## Verify commands — ALREADY RUN by Chorus (authoritative; do NOT re-run)");
      if (cmds.length) for (const c of cmds) L.push(`- \`${c}\``);
      L.push("");
      L.push("Output:");
      L.push(verify.output);
      L.push("");
      L.push(
        "Judge from this output plus inspecting the committed diff/acceptance criteria. Set `passed` true ONLY if the commands all succeeded AND the ticket is genuinely satisfied; otherwise give a precise `diagnosis` of the SPECIFIC next change needed.",
      );
    } else {
      L.push("## No verify commands were run — inspect the diff and judge correctness");
      if (cmds.length) {
        L.push("Configured verify commands (run them if useful):");
        for (const c of cmds) L.push(`- \`${c}\``);
      }
      L.push("");
      L.push(
        "Set `passed` true ONLY if the ticket is genuinely satisfied; otherwise give a precise `diagnosis` of the SPECIFIC next change needed.",
      );
    }
    L.push("");
    L.push(EVIDENCE_SCOPE_RULE);
    L.push(PROSE_NARRATION_RULE);
    return L.join("\n");
  }

  private buildReviewerPrompt(project: Project, ticket: Ticket): string {
    const L: string[] = [];
    L.push("# You are the REVIEWER agent (read-only)");
    L.push(
      `Review the diff of branch \`${ticket.branch}\` vs \`origin/${project.baseBranch}\` (run \`git diff origin/${project.baseBranch}..${ticket.branch}\`).`,
    );
    L.push("Judge whether it correctly and completely satisfies the ticket and is safe to open as a PR.");
    L.push("");
    L.push(READ_ONLY_RULE);
    L.push("");
    L.push("## Ticket");
    L.push(`${ticket.title}`);
    L.push(ticket.body);
    L.push("");
    L.push(
      "Return `approved`, a one-paragraph `summary`, concrete `risks`, a `rollback` plan, and any `uncertainties`.",
    );
    L.push("");
    L.push(EVIDENCE_SCOPE_RULE);
    L.push(PROSE_NARRATION_RULE);
    return L.join("\n");
  }

  /**
   * Push the ticket's branch and open (or update) a GitHub PR with a rich,
   * reviewable body. Returns the PR url (or null if it could not be opened).
   * Only called after the acceptance gate passes.
   */
  private async openPrForTicket(
    project: Project,
    ticket: Ticket,
    accepted: {
      taskId: string | null;
      verify: { ran: boolean; results: { cmd: string; ok: boolean }[] };
      reviewer: ReviewerVerdict | null;
    },
  ): Promise<string | null> {
    if (!ticket.branch) return null;
    let pr: { url: string; number: number | null; state: string };
    try {
      await this.deps.git.pushBranch(project.localPath, ticket.branch);
      pr = await this.deps.git.openOrUpdatePr(
        project.localPath,
        ticket.branch,
        project.baseBranch,
        ticket.title,
        this.buildPrBody(project, ticket, accepted),
      );
    } catch (err) {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "pr", `Could not push/open PR: ${String(err)}`);
      this.blockTicket(project, ticket, `Could not push the branch or open a PR: ${String(err)}`);
      return null;
    }

    const prId = newId("pr");
    const now = Date.now();
    this.deps.db.insertPullRequest({
      id: prId,
      ticketId: ticket.id,
      projectId: project.id,
      taskId: accepted.taskId,
      url: pr.url,
      number: pr.number,
      state: pr.state,
      createdAt: now,
      updatedAt: now,
    });
    this.deps.bus.emit({ type: "pr", projectId: project.id, ticketId: ticket.id, prId, at: now });
    this.deps.db.insertChangelog({
      id: newId("cl"),
      projectId: project.id,
      ticketId: ticket.id,
      prId,
      entry: ticket.title,
      agentRole: ORCHESTRATOR_ROLE,
      createdAt: now,
    });

    this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "pr", `Opened PR against ${project.baseBranch}: ${pr.url}`);
    // Keep `branch` (the poller queries the PR by head branch); free the worktree.
    await this.cleanupWorktree(project, ticket);
    this.deps.db.updateTicket(ticket.id, {
      status: "pr_open",
      prUrl: pr.url,
      prNumber: pr.number,
      worktreePath: null,
    });
    this.lastAttempt.delete(ticket.id);
    this.emitTicket(project.id, ticket.id);
    await this.notify("pr_opened", project, "PR opened", `${ticket.title}\n${pr.url}`);
    return pr.url;
  }

  /** Build a reviewable PR body: summary, ticket, checks, risks, rollback, uncertainty. */
  private buildPrBody(
    project: Project,
    ticket: Ticket,
    accepted: {
      taskId: string | null;
      verify: { ran: boolean; results: { cmd: string; ok: boolean }[] };
      reviewer: ReviewerVerdict | null;
    },
  ): string {
    const { reviewer, verify, taskId } = accepted;
    const L: string[] = [];
    if (reviewer?.summary) {
      L.push("## Summary", reviewer.summary, "");
    }
    L.push("## Ticket", `${ticket.id}: ${ticket.title}`, "", ticket.body, "");
    L.push("## How to verify");
    const cmds = (project.verifyCommands ?? []).filter((c) => c.trim());
    if (cmds.length) for (const c of cmds) L.push(`- \`${c}\``);
    else L.push("- (no verify commands configured)");
    L.push("");
    L.push("## Checks");
    if (verify.ran && verify.results.length)
      for (const r of verify.results) L.push(`- ${r.ok ? "✅" : "❌"} \`${r.cmd}\``);
    else L.push("- (verify commands not run)");
    if (reviewer) {
      if (reviewer.risks.length) {
        L.push("", "## Risks");
        for (const r of reviewer.risks) L.push(`- ${r}`);
      }
      if (reviewer.rollback?.trim()) L.push("", "## Rollback", reviewer.rollback.trim());
      if (reviewer.uncertainties.length) {
        L.push("", "## Uncertainty");
        for (const u of reviewer.uncertainties) L.push(`- ${u}`);
      }
    }
    L.push("", "---", `_Opened by Chorus for ticket ${ticket.id}${taskId ? ` (task ${taskId})` : ""}._`);
    return L.join("\n");
  }

  /**
   * Poll every "pr_open" ticket's PR on GitHub. When a PR is merged, flip the
   * ticket to "merged"; when it's closed without merging, return it to the
   * orchestrator for a fresh decision. Read-only `gh` calls; failures are
   * swallowed so a transient error doesn't disrupt dispatch.
   */
  private async pollOpenPrs(): Promise<void> {
    for (const project of this.deps.db.listProjects()) {
      const open = this.deps.db.listTicketsByStatus(project.id, "pr_open");
      for (const ticket of open) {
        if (!ticket.branch) continue;
        let state: Awaited<ReturnType<GitService["getPrState"]>>;
        try {
          state = await this.deps.git.getPrState(project.localPath, ticket.branch);
        } catch {
          continue;
        }
        if (!state) continue;
        const merged = state.state === "MERGED" || state.mergedAt != null;
        if (merged) {
          this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "pr", `PR merged on GitHub: ${state.url}`);
          await this.cleanupWorktree(project, ticket);
          this.deps.db.updateTicket(ticket.id, { status: "merged", branch: null, worktreePath: null });
          this.emitTicket(project.id, ticket.id);
          await this.notify("pr_merged", project, "PR merged", `${ticket.title}\n${state.url}`).catch(() => {});
        } else if (state.state === "CLOSED") {
          this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "pr", `PR closed without merging: ${state.url}`);
          // The worktree was removed when the PR opened. Clear the branch too so
          // a future attempt starts fresh (a stale branch with no worktree makes
          // runWorker treat it as a resume and run in a directory that's gone).
          this.deps.db.updateTicket(ticket.id, { branch: null });
          this.handBackToOrchestrator(project.id, ticket.id);
        }
      }
    }
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
      prUrl: null,
      prNumber: null,
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

  /** Remote-tracking ref for the project's base branch (fetched in addWorktree). */
  private baseRef(project: Project): string {
    return `origin/${project.baseBranch}`;
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
    kind: "pr_opened" | "pr_merged" | "needs_review" | "quota_paused" | "error",
    project: Project,
    title: string,
    body: string,
  ): Promise<void> {
    this.deps.bus.emit({ type: "notification", projectId: project.id, kind, title, body, at: Date.now() });
    await this.deps.notifier.notify({ kind, projectId: project.id, title, body, at: Date.now() });
  }
}
