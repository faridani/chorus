import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BackendRegistry, mapCodexLine } from "@chorus/backends";
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
import { runShell, StreamingProcess } from "@chorus/proc";
import {
  buildAutonomousPrompt,
  buildCodexMcpArgs,
  buildSpokeAgentPrompt,
  isCodingRole,
  type SessionState,
  type SpokeAgentInfo,
} from "./autonomous.js";
import { type EvaluatorVerdict, runEvaluator } from "./evaluate.js";
import { buildManifest, type TaskManifest } from "./manifest.js";
import { buildAgentPrompt, buildOrchestratorPrompt } from "./prompt.js";
import { type ReviewerVerdict, runReviewer } from "./review.js";
import { runAgentProcess } from "./spoke-runner.js";
import {
  EVIDENCE_SCOPE_RULE,
  looksLikeJsonObject,
  PROSE_NARRATION_RULE,
  READ_ONLY_RULE,
} from "./structured-run.js";
import {
  runIdleTicketGeneration,
  type IdleTicketGenerationInput,
  type IdleTicketGenerator,
} from "./ticket-generation.js";
import { runTriage } from "./triage.js";

export interface OrchestratorDeps {
  db: ChorusDb;
  git: GitService;
  backends: BackendRegistry;
  notifier: Notifier;
  bus: ChorusBus;
  config: Config;
  idleTicketGenerator?: IdleTicketGenerator;
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
  /** Live autonomous sessions, keyed by their (unguessable) MCP token. */
  private readonly sessions = new Map<string, SessionState>();
  /** ticketId → consecutive autonomous sessions that ended without resolving it. */
  private readonly sessionFailures = new Map<string, number>();
  /** projectId set while an empty-queue ticket is being generated. */
  private readonly idleTicketGenerations = new Set<string>();
  /** projectId → retry timestamp after a non-quota ticket generation failure. */
  private readonly idleTicketGenerationRetryAfter = new Map<string, number>();
  private static readonly IDLE_TICKET_GENERATION_RETRY_MS = 60_000;
  /**
   * Statuses that represent actively-queued or in-flight work. The queue counts
   * as "drained" (eligible for idle ideation) when no ticket is in one of these
   * — i.e. nothing is waiting to be dispatched or running. Tickets in `pr_open`
   * (awaiting a human merge) or `blocked` deliberately do NOT count as work in
   * the queue, so a project whose only remaining tickets are open PRs / blocked
   * still ideates new work when the toggle is on. (Trade-off: that new work is
   * cut from the base branch, which won't yet include the open PRs; the ideation
   * prompt feeds prior ticket titles to the model to avoid duplicating them.)
   */
  private static readonly QUEUED_OR_ACTIVE_TICKET_STATUSES = new Set<Ticket["status"]>([
    "open",
    "assigned",
    "in_progress",
  ]);

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
        if (!ticket) {
          this.maybeGenerateIdleTicket(project);
          continue;
        }
        void this.processTicket(ticket);
      }
    } finally {
      this.ticking = false;
    }
  }

  private maybeGenerateIdleTicket(project: Project): void {
    if (this.idleTicketGenerations.has(project.id)) return;
    // Opt-in per project: only ideate when the toggle is on and a positive count.
    if (!project.idleIdeation) return;
    const count = Math.min(10, Math.max(0, Math.floor(project.idleIdeationCount)));
    if (count < 1) return;
    const retryAt = this.idleTicketGenerationRetryAfter.get(project.id);
    if (retryAt && retryAt > Date.now()) return;
    if (!this.isTicketQueueDrained(project.id)) return;

    this.idleTicketGenerations.add(project.id);
    void this.generateIdleTickets(project.id, count)
      .then(() => {
        this.idleTicketGenerationRetryAfter.delete(project.id);
      })
      .catch((err) => {
        if (this.looksLikeQuota(String(err))) {
          this.enterQuotaBackoff();
        } else {
          console.error("[chorus] idle ticket generation error:", err);
          this.idleTicketGenerationRetryAfter.set(
            project.id,
            Date.now() + Orchestrator.IDLE_TICKET_GENERATION_RETRY_MS,
          );
        }
      })
      .finally(() => {
        this.idleTicketGenerations.delete(project.id);
      });
  }

  /**
   * Generate up to `count` follow-up tickets in one idle pass. Each ticket is
   * created as it is produced, so the next iteration's prompt (which reads the
   * ticket list fresh) sees it and avoids duplicating it. The pass stops early if
   * the project leaves the running/ready state, the daemon stops, or *external*
   * work appears in the queue (work we didn't create this pass).
   */
  private async generateIdleTickets(projectId: string, count: number): Promise<void> {
    const project = this.deps.db.getProject(projectId);
    if (!project || project.status !== "ready" || project.runState !== "running") return;
    if (this.state !== "running") return;
    if (!this.isTicketQueueDrained(project.id)) return;

    const generator = this.deps.idleTicketGenerator ?? runIdleTicketGeneration;
    const createdIds = new Set<string>();
    for (let i = 0; i < count; i++) {
      const current = this.deps.db.getProject(projectId);
      if (!current || current.status !== "ready" || current.runState !== "running") break;
      if (this.state !== "running") break;
      // A human (or another path) queued real work while we were generating.
      if (this.hasExternalQueuedWork(projectId, createdIds)) break;

      const draft = await generator(this.buildIdleTicketGenerationInput(current));
      const title = draft.title.trim();
      const body = draft.body.trim();
      if (!title || !body) throw new Error("idle ticket generation returned an empty ticket");

      // Re-check liveness after the (slow) model call before persisting.
      const refreshed = this.deps.db.getProject(projectId);
      if (!refreshed || refreshed.status !== "ready" || refreshed.runState !== "running") break;
      if (this.state !== "running") break;

      const ticket = this.createFollowUpTicket(projectId, { title, body, priority: 1 });
      createdIds.add(ticket.id);
      this.trail(
        projectId,
        ticket.id,
        "system",
        "note",
        "Auto-generated after the project ticket queue became empty.",
      );
    }
  }

  private isTicketQueueDrained(projectId: string): boolean {
    if (this.projectBusy(projectId)) return false;
    const tickets = this.deps.db.listTickets(projectId);
    if (tickets.length === 0) return false;
    return !tickets.some((t) => Orchestrator.QUEUED_OR_ACTIVE_TICKET_STATUSES.has(t.status));
  }

  /** True if the queue holds queued/active work that wasn't created in this pass. */
  private hasExternalQueuedWork(projectId: string, createdIds: Set<string>): boolean {
    return this.deps.db
      .listTickets(projectId)
      .some((t) => Orchestrator.QUEUED_OR_ACTIVE_TICKET_STATUSES.has(t.status) && !createdIds.has(t.id));
  }

  private buildIdleTicketGenerationInput(project: Project): IdleTicketGenerationInput {
    const orchRole = this.deps.db.getRole(project.id, ORCHESTRATOR_ROLE);
    return {
      project,
      tickets: this.deps.db.listTickets(project.id),
      recentEvents: this.deps.db.listProjectTicketEvents(project.id, 80),
      attemptJournal: this.deps.db.listProjectAttemptJournal(project.id, 40),
      changelog: this.deps.db.listChangelog(project.id, 40),
      specExcerpt: this.readSpecExcerpt(project),
      artifactsDir: join(this.deps.config.dataDir, "idle-ticket-generation", project.id, newId("itg")),
      model: orchRole?.model,
      maxWallClockMs: this.deps.config.agent.maxWallClockMs,
      idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
    };
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
        if (this.deps.config.orchestrator.mode === "autonomous") {
          await this.runAutonomousSession(project, ticket);
        } else {
          await this.runOrchestratorDecision(project, ticket);
        }
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

  // ---- autonomous session (fully LLM-driven orchestration) ----
  /**
   * Run the orchestrator as an autonomous `codex exec` agent that calls spoke
   * agents (and verify / diff / merge / PR actions) as MCP tools, deciding
   * turn-by-turn. The codex process drives everything; this method just spawns
   * it (with the Chorus MCP bridge attached over a session token), streams its
   * events, and cleans up when it exits.
   */
  private async runAutonomousSession(project: Project, ticket: Ticket): Promise<void> {
    if (this.workerAttempts(ticket.id) >= this.deps.config.maxAttemptsPerTicket) {
      this.addSuggestion(project, ticket.id, `Ticket reached ${this.deps.config.maxAttemptsPerTicket} attempts without completion.`);
      this.blockTicket(project, ticket, "Max attempts reached.");
      return;
    }

    const token = newId("ses");
    const session: SessionState = {
      token,
      projectId: project.id,
      ticketId: ticket.id,
      ticketTitle: ticket.title,
      worktrees: new Map(),
      spokeCount: 0,
      running: 0,
      createdAt: Date.now(),
      finished: null,
      prUrl: null,
      handles: new Set(),
    };
    this.sessions.set(token, session);

    const agents: SpokeAgentInfo[] = this.deps.db
      .listRoles(project.id)
      .filter((r) => r.name !== ORCHESTRATOR_ROLE)
      .map((r) => ({ name: r.name, description: r.description, backendId: r.backendId }));

    const prompt = buildAutonomousPrompt({
      project,
      ticket,
      agents,
      maxSpokeAgents: this.deps.config.orchestrator.maxSpokeAgentsPerSession,
      maxParallel: this.deps.config.orchestrator.maxParallelSpokeAgents,
    });

    // Freshen the clone the orchestrator inspects: it's read-only context, and a
    // clone left at its original checkout goes stale as the base branch advances
    // (the orchestrator would then plan against outdated code). Spoke worktrees
    // are already cut from the fetched base; this aligns the orchestrator's view.
    await this.deps.git.syncToBase(project.localPath, project.baseBranch).catch((err) => {
      this.trail(project.id, ticket.id, ORCHESTRATOR_ROLE, "note", `Could not refresh base checkout: ${String(err)}`);
    });

    const artifactsDir = join(this.deps.config.dataDir, "autonomous", ticket.id, newId("a"));
    mkdirSync(artifactsDir, { recursive: true });
    // A spoke run can take up to the agent wall-clock plus setup (npm install
    // etc.); give the MCP tool call generous headroom beyond that so codex
    // doesn't abandon a still-running delegation.
    const toolTimeoutSec = Math.ceil(this.deps.config.agent.maxWallClockMs / 1000) + 30 * 60;
    // Reach the daemon on the interface it actually bound to: 0.0.0.0 is
    // reachable via loopback, but a specific bind host is not.
    const daemonHost = this.deps.config.host === "0.0.0.0" ? "127.0.0.1" : this.deps.config.host;
    const mcpArgs = buildCodexMcpArgs(
      this.bridgeBinPath(),
      `http://${daemonHost}:${this.deps.config.port}`,
      token,
      toolTimeoutSec,
    );
    const args = [
      "exec",
      "--json",
      // Bypass codex's own sandbox: the MCP bridge (a codex subprocess) must
      // reach the loopback daemon, and a read-only sandbox blocks that egress.
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      ...mcpArgs,
      "-C",
      project.localPath,
      prompt,
    ];

    this.emitAgentEvent(project.id, ticket, ORCHESTRATOR_ROLE, {
      kind: "message",
      text: "Orchestrator session starting…",
      at: Date.now(),
    });

    const proc = new StreamingProcess("codex", args, {
      cwd: project.localPath,
      rawLogPath: join(artifactsDir, "orchestrator.log"),
      maxWallClockMs: this.deps.config.orchestrator.sessionWallClockMs,
      // The orchestrator is silent while awaiting a tool result that may take
      // minutes (a spoke agent run) — never treat that as idle.
      idleTimeoutMs: undefined,
    });
    const slot = this.active.get(ticket.id);
    if (slot)
      slot.stop = async () => {
        await proc.stop();
        await Promise.allSettled([...session.handles].map((h) => h.stop("killed")));
      };
    proc.onLine((line) => {
      for (const ev of mapCodexLine(line, project.localPath)) {
        // Drop schema-shaped JSON the model streams as interim "messages" (e.g.
        // premature result emissions) so they don't flood the live feed.
        if (ev.kind === "message" && looksLikeJsonObject(ev.text)) continue;
        this.emitAgentEvent(project.id, ticket, ORCHESTRATOR_ROLE, ev);
      }
    });

    let exitOutcome = "";
    let stderrTail = "";
    try {
      const exit = await proc.exit;
      exitOutcome = exit.outcome;
      stderrTail = exit.stderrTail;
    } catch (err) {
      stderrTail = String(err);
    } finally {
      this.sessions.delete(token);
    }

    // Quota mid-session: back off and leave the ticket for a later retry.
    if (this.looksLikeQuota(stderrTail)) {
      this.enterQuotaBackoff();
      await this.cleanupSessionWorktrees(project, session, null);
      this.deps.db.updateTicket(ticket.id, { status: "open", roleName: ORCHESTRATOR_ROLE });
      return;
    }

    // A session counts as resolved only if a terminal tool action actually moved
    // the ticket: open_pr → pr_open, close_ticket → closed, needs_human →
    // blocked. A bare finish("abandoned"), a finish without a terminal action,
    // or a crash before any tool call leaves the ticket "in_progress" — NOT
    // resolved (otherwise it would silently strand, dropping out of dispatch).
    const after = this.deps.db.getTicket(ticket.id);
    const TERMINAL = new Set(["pr_open", "merged", "closed", "blocked"]);
    if (after && TERMINAL.has(after.status)) {
      this.sessionFailures.delete(ticket.id);
      // Keep the PR branch; drop every other scratch worktree.
      await this.cleanupSessionWorktrees(project, session, session.prUrl ? "keep-pr" : null);
      this.trail(
        project.id,
        ticket.id,
        ORCHESTRATOR_ROLE,
        "triage",
        `Session ${session.finished?.outcome ?? after.status}: ${session.finished?.message ?? ""}`,
      );
      return;
    }

    // Not resolved (crash, abandoned, or finish without a terminal action).
    // Count failures per ticket so a persistently-failing session can't spin
    // forever — the worker-attempt guard never trips when no spoke ever ran.
    await this.cleanupSessionWorktrees(project, session, null);
    const failures = (this.sessionFailures.get(ticket.id) ?? 0) + 1;
    this.sessionFailures.set(ticket.id, failures);
    const reason = session.finished
      ? `finished as "${session.finished.outcome}" without opening a PR, closing, or escalating`
      : `ended without a terminal action (${exitOutcome || "exited"})`;
    if (failures >= this.deps.config.maxAttemptsPerTicket) {
      this.sessionFailures.delete(ticket.id);
      this.blockTicket(project, ticket, `Autonomous orchestrator ${reason} ${failures}×. Parking for a human.`);
      return;
    }
    this.trail(
      project.id,
      ticket.id,
      ORCHESTRATOR_ROLE,
      "note",
      `Orchestrator session ${reason} (try ${failures}/${this.deps.config.maxAttemptsPerTicket}). Will retry.`,
    );
    this.handBackToOrchestrator(project.id, ticket.id);
  }

  /** Absolute path to the compiled MCP bridge codex launches. */
  private bridgeBinPath(): string {
    if (process.env.CHORUS_MCP_BRIDGE) return process.env.CHORUS_MCP_BRIDGE;
    const here = dirname(fileURLToPath(import.meta.url)); // packages/orchestrator/{src|dist}
    return join(here, "..", "..", "agent-mcp", "dist", "bin.js");
  }

  private async cleanupSessionWorktrees(
    project: Project,
    session: SessionState,
    keep: "keep-pr" | null,
  ): Promise<void> {
    const ticket = this.deps.db.getTicket(session.ticketId);
    const keepBranch = keep === "keep-pr" ? ticket?.branch : null;
    for (const wt of session.worktrees.values()) {
      if (keepBranch && wt.branch === keepBranch) continue;
      try {
        await this.deps.git.removeWorktree(project.localPath, wt.path);
      } catch {
        /* best-effort */
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Entry point for the daemon's internal MCP API. Dispatches a tool call from
   * the bridge (scoped by session token) to the matching session action. Always
   * resolves to a {status, body}; never throws.
   */
  async sessionCall(
    token: string,
    action: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const session = this.sessions.get(token);
    if (!session) return { status: 404, body: { error: "unknown or expired session" } };
    const project = this.deps.db.getProject(session.projectId);
    const ticket = this.deps.db.getTicket(session.ticketId);
    if (!project || !ticket) return { status: 410, body: { error: "session target gone" } };
    try {
      switch (action) {
        case "context":
          return { status: 200, body: this.sessionContext(project, ticket, session) };
        case "agents":
          return { status: 200, body: this.sessionAgents(project) };
        case "run-agent":
          return await this.runAgentInSession(session, project, ticket, body);
        case "verify":
          return await this.sessionVerify(session, project, body);
        case "diff":
          return await this.sessionDiff(session, project, body);
        case "merge":
          return await this.sessionMerge(session, project, body);
        case "open-pr":
          return await this.sessionOpenPr(session, project, ticket, body);
        case "close":
          await this.closeTicket(project, ticket, "closed");
          session.finished = { outcome: "closed", message: String(body.reason ?? "") };
          return { status: 200, body: { ok: true } };
        case "needs-human":
          this.blockTicket(project, ticket, String(body.reason ?? "needs human"));
          session.finished = { outcome: "blocked", message: String(body.reason ?? "") };
          return { status: 200, body: { ok: true } };
        case "create-ticket":
          this.createFollowUpTicket(project.id, {
            title: String(body.title ?? "Untitled"),
            body: String(body.body ?? ""),
            priority: typeof body.priority === "number" ? body.priority : undefined,
          });
          return { status: 200, body: { ok: true } };
        case "suggest":
          this.addSuggestion(project, ticket.id, String(body.text ?? ""));
          return { status: 200, body: { ok: true } };
        case "activity":
          this.emitAgentEvent(project.id, ticket, ORCHESTRATOR_ROLE, {
            kind: "message",
            text: String(body.message ?? ""),
            at: Date.now(),
          });
          return { status: 200, body: { ok: true } };
        case "finish":
          session.finished = session.finished ?? {
            outcome: String(body.outcome ?? "abandoned"),
            message: String(body.message ?? ""),
          };
          return { status: 200, body: { ok: true } };
        default:
          return { status: 404, body: { error: `unknown action: ${action}` } };
      }
    } catch (err) {
      return { status: 500, body: { error: String(err) } };
    }
  }

  private sessionAgents(project: Project): SpokeAgentInfo[] {
    return this.deps.db
      .listRoles(project.id)
      .filter((r) => r.name !== ORCHESTRATOR_ROLE)
      .map((r) => ({ name: r.name, description: r.description, backendId: r.backendId }));
  }

  private sessionContext(project: Project, ticket: Ticket, session: SessionState): unknown {
    return {
      ticket: { id: ticket.id, title: ticket.title, body: ticket.body, status: ticket.status },
      project: {
        repoUrl: project.repoUrl,
        baseBranch: project.baseBranch,
        expectations: project.expectations,
        groundRules: project.groundRules,
        setupCommand: project.setupCommand,
        verifyCommands: project.verifyCommands,
      },
      agents: this.sessionAgents(project),
      trail: this.deps.db
        .listTicketEvents(ticket.id)
        .slice(-20)
        .map((e) => ({ actor: e.actor, kind: e.kind, message: e.message })),
      latestJournal: this.deps.db.latestAttemptJournal(ticket.id),
      worktrees: [...session.worktrees.values()].map((w) => ({ id: w.id, branch: w.branch })),
      budget: {
        spokeAgentsUsed: session.spokeCount,
        spokeAgentsMax: this.deps.config.orchestrator.maxSpokeAgentsPerSession,
      },
    };
  }

  private async runAgentInSession(
    session: SessionState,
    project: Project,
    ticket: Ticket,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const agentName = String(body.agent ?? "");
    const instruction = String(body.instruction ?? "");
    const baseWorktreeId = body.baseWorktreeId ? String(body.baseWorktreeId) : null;

    if (session.spokeCount >= this.deps.config.orchestrator.maxSpokeAgentsPerSession) {
      return {
        status: 429,
        body: { error: "spoke-agent budget exhausted for this ticket; wrap up and finish." },
      };
    }
    const role = this.deps.db.getRole(project.id, agentName);
    if (!role) {
      return {
        status: 400,
        body: { error: `unknown agent "${agentName}". Available: ${this.sessionAgents(project).map((a) => a.name).join(", ")}` },
      };
    }
    // Respect the parallelism cap; queue until a slot frees.
    while (session.running >= this.deps.config.orchestrator.maxParallelSpokeAgents) {
      await this.sleep(250);
      if (!this.sessions.has(session.token)) return { status: 410, body: { error: "session ended" } };
    }

    session.running++;
    session.spokeCount++;
    // Advisory (read-only) roles don't edit the repo, so their runs skip the
    // setup command (which can mutate tracked files like lockfiles) and the
    // leftover-changes autocommit — keeping the read-only contract real, not
    // just prompt guidance.
    const coding = isCodingRole(role);
    // Tracked so we can drop it from session.handles once this run exits (the
    // set is only needed to kill in-flight runs on Stop).
    let activeHandle: { stop: (r: "killed") => Promise<void> } | null = null;
    try {
      // Resolve (or create) the worktree for this run.
      let wt = baseWorktreeId ? session.worktrees.get(baseWorktreeId) : undefined;
      const resume = !!wt;
      if (!wt) {
        const id = newId("wt");
        const branch = `chorus/${ticket.id}/${id}`;
        const path = join(this.deps.config.dataDir, "worktrees", project.id, ticket.id, id);
        await this.deps.git.addWorktree(project.localPath, path, branch, project.baseBranch);
        wt = { id, path, branch };
        session.worktrees.set(id, wt);
        if (coding) await this.runSetup(project, ticket, path);
      }

      const backend = this.deps.backends.has(role.backendId)
        ? this.deps.backends.get(role.backendId)
        : this.deps.backends.get("codex");
      const taskId = newId("task");
      const runId = newId("run");
      const now = Date.now();
      const baseCommit = await this.deps.git.headCommit(project.localPath, this.baseRef(project));
      this.deps.db.insertTask({
        id: taskId,
        ticketId: ticket.id,
        projectId: project.id,
        backendId: role.backendId,
        worktreePath: wt.path,
        branch: wt.branch,
        baseCommit,
        state: "running",
        attempt: session.spokeCount,
        resumeAt: null,
        startedAt: now,
        endedAt: null,
      });
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
      const commitsBefore = (
        await this.deps.git.branchSummary(project.localPath, this.baseRef(project), wt.branch).catch(() => ({ commits: [] as string[] }))
      ).commits.length;

      const updateNote = await backend.prepare?.();
      if (updateNote) this.trail(project.id, ticket.id, role.name, "note", updateNote);
      const prompt = buildSpokeAgentPrompt({
        project,
        ticket,
        role,
        instruction,
        resume,
        trail: this.deps.db.listTicketEvents(ticket.id),
      });

      let result: AgentResult;
      try {
        result = await runAgentProcess({
          backend,
          spec: {
            taskId,
            prompt,
            worktreePath: wt.path,
            model: role.model,
            resume,
            maxWallClockMs: this.deps.config.agent.maxWallClockMs,
            idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
            artifactsDir: join(this.deps.config.dataDir, "runs", taskId, runId),
          },
          bus: this.deps.bus,
          projectId: project.id,
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          roleName: role.name,
          onHandle: (handle) => {
            this.deps.db.updateRun(runId, { pid: handle.pid ?? null, pgid: handle.pgid ?? null });
            activeHandle = handle;
            session.handles.add(handle);
          },
        });
      } catch (err) {
        this.deps.db.updateTask(taskId, { state: "failed", endedAt: Date.now() });
        this.deps.db.updateRun(runId, { endedAt: Date.now(), terminalReason: "failed" });
        this.trail(project.id, ticket.id, role.name, "work", `Run errored: ${String(err)}`);
        return { status: 200, body: { worktreeId: wt.id, terminalReason: "failed", error: String(err) } };
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
        this.deps.db.updateTask(taskId, { state: "paused-quota", endedAt: Date.now() });
        return {
          status: 200,
          body: { worktreeId: wt.id, terminalReason: "quota_exhausted", error: "quota exhausted; pause and finish." },
        };
      }

      // Capture anything a coding agent left uncommitted (invisible to diff/PR
      // otherwise). Advisory runs are read-only: nothing should be committed,
      // and any incidental dirt is left for the worktree teardown to discard.
      if (coding && !(await this.deps.git.isWorktreeClean(wt.path))) {
        try {
          await this.deps.git.commitAll(wt.path, `${ticket.title}\n\n[chorus] auto-committed leftover changes`);
        } catch {
          /* best-effort */
        }
      }
      this.deps.db.updateTask(taskId, { state: "done-pending-merge", endedAt: Date.now() });

      const after = await this.deps.git
        .branchSummary(project.localPath, this.baseRef(project), wt.branch)
        .catch(() => ({ commits: [] as string[], files: [] as string[] }));
      const newCommits = Math.max(0, after.commits.length - commitsBefore);
      const summary = result.payload?.summary ?? `(${result.terminalReason})`;
      this.trail(
        project.id,
        ticket.id,
        role.name,
        "work",
        `[${wt.id}] ${result.payload?.status ?? result.terminalReason}: ${summary}${newCommits ? "" : " [no new commits]"}`,
      );

      return {
        status: 200,
        body: {
          worktreeId: wt.id,
          branch: wt.branch,
          status: result.payload?.status ?? null,
          summary: result.payload?.summary ?? null,
          filesChanged: result.payload?.filesChanged ?? [],
          notes: result.payload?.notes ?? null,
          newCommits,
          changedFiles: after.files,
          terminalReason: result.terminalReason,
        },
      };
    } finally {
      if (activeHandle) session.handles.delete(activeHandle);
      session.running--;
    }
  }

  private async sessionVerify(
    session: SessionState,
    project: Project,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const wt = session.worktrees.get(String(body.worktreeId ?? ""));
    if (!wt) return { status: 400, body: { error: "unknown worktreeId" } };
    const verify = await this.runVerify(project, wt.path);
    return { status: 200, body: verify };
  }

  private async sessionDiff(
    session: SessionState,
    project: Project,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const wt = session.worktrees.get(String(body.worktreeId ?? ""));
    if (!wt) return { status: 400, body: { error: "unknown worktreeId" } };
    const diff = await this.deps.git
      .diff(project.localPath, this.baseRef(project), wt.branch)
      .catch(() => "");
    return { status: 200, body: { diff: diff.slice(0, 60000), truncated: diff.length > 60000 } };
  }

  private async sessionMerge(
    session: SessionState,
    project: Project,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const from = session.worktrees.get(String(body.fromWorktreeId ?? ""));
    const into = session.worktrees.get(String(body.intoWorktreeId ?? ""));
    if (!from || !into) return { status: 400, body: { error: "unknown worktreeId(s)" } };
    const r = await runShell(`git merge --no-ff --no-edit ${from.branch}`, into.path, {
      timeoutMs: 5 * 60 * 1000,
    });
    if (!r.ok) {
      await runShell("git merge --abort", into.path, { timeoutMs: 60 * 1000 }).catch(() => {});
      return { status: 200, body: { ok: false, conflicts: true, output: r.combined.slice(-2000) } };
    }
    return { status: 200, body: { ok: true } };
  }

  private async sessionOpenPr(
    session: SessionState,
    project: Project,
    ticket: Ticket,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: unknown }> {
    const wt = session.worktrees.get(String(body.worktreeId ?? ""));
    if (!wt) return { status: 400, body: { error: "unknown worktreeId" } };
    const summary = String(body.summary ?? "");
    if (!(await this.deps.git.hasNewCommits(project.localPath, this.baseRef(project), wt.branch))) {
      return { status: 400, body: { error: "that worktree has no commits beyond the base branch" } };
    }
    // Point the ticket at the chosen worktree's branch so the PR opener and the
    // merge poller operate on it, then reuse the standard PR path.
    this.deps.db.updateTicket(ticket.id, { branch: wt.branch, worktreePath: wt.path });
    const updated: Ticket = { ...ticket, branch: wt.branch, worktreePath: wt.path };
    const url = await this.openPrForTicket(project, updated, {
      taskId: null,
      verify: { ran: false, results: [] },
      reviewer: { approved: true, summary, risks: [], rollback: "", uncertainties: [] },
    });
    if (!url) return { status: 500, body: { error: "could not open PR (see ticket trail)" } };
    session.finished = { outcome: "pr_opened", message: summary };
    session.prUrl = url;
    return { status: 200, body: { url } };
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
    // One-time-per-process CLI self-update (memoized by the backend). Blocks
    // only the first run per backend; failures log-and-continue (returns null).
    const updateNote = await backend.prepare?.();
    if (updateNote) this.trail(project.id, ticket.id, role.name, "note", updateNote);

    let result: AgentResult;
    try {
      result = await runAgentProcess({
        backend,
        spec: {
          taskId,
          prompt,
          worktreePath,
          model: role.model,
          resume,
          maxWallClockMs: this.deps.config.agent.maxWallClockMs,
          idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
          artifactsDir: join(this.deps.config.dataDir, "runs", taskId, runId),
        },
        bus: this.deps.bus,
        projectId: project.id,
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        roleName: role.name,
        onHandle: (handle) => {
          this.deps.db.updateRun(runId, { pid: handle.pid ?? null, pgid: handle.pgid ?? null });
          const slot = this.active.get(ticket.id);
          if (slot) slot.stop = () => handle.stop("killed");
        },
      });
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

    // Backstop: if the worker edited files but didn't commit them, capture that
    // work now. Uncommitted changes are invisible to the acceptance gate (which
    // judges the committed branch) and are lost on the next reset — exactly the
    // failure we saw where a requested fix sat uncommitted in the worktree while
    // the gate kept rejecting the stale HEAD. `git add -A` honors .gitignore, so
    // build artifacts / node_modules aren't swept in.
    if (!(await this.deps.git.isWorktreeClean(worktreePath))) {
      try {
        const head = await this.deps.git.commitAll(
          worktreePath,
          `${ticket.title}\n\n[chorus] auto-committed changes ${role.name} left uncommitted`,
        );
        if (head) {
          this.trail(
            project.id,
            ticket.id,
            role.name,
            "work",
            "Auto-committed changes the worker left uncommitted in the worktree.",
          );
        }
      } catch (err) {
        this.trail(
          project.id,
          ticket.id,
          role.name,
          "work",
          `Could not auto-commit leftover worktree changes: ${String(err)}`,
        );
      }
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

  private createFollowUpTicket(projectId: string, t: { title: string; body: string; priority?: number }): Ticket {
    const now = Date.now();
    const id = newId("tkt");
    const ticket: Ticket = {
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
      starred: false,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insertTicket(ticket);
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId: id, at: now });
    return ticket;
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
