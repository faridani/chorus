import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackendRegistry } from "@chorus/backends";
import {
  type AgentResult,
  type AIBackend,
  type AgentTemplate,
  type ApplyAgentTemplateInput,
  type BackendInfo,
  type ChorusBus,
  type Config,
  type ControlApi,
  type CleanupTicketsInput,
  type CleanupTicketsResult,
  type CreateProjectInput,
  type CreateTicketInput,
  type DiagnosisResult,
  newId,
  ORCHESTRATOR_ROLE,
  type Project,
  type ProjectRunState,
  type ProjectSettingsInput,
  type UpsertAgentTemplateInput,
  type Role,
  type SelfHealProposal,
  type SelfHealResult,
  templateToRoleInput,
  type Ticket,
  TOOL_CATALOG,
  type UpdateTicketInput,
  type UpsertRoleInput,
  validateToolSelection,
  CODING_TOOLS,
  getBuiltInAgentTemplate,
  ORCHESTRATOR_TOOLS,
  TICKET_CLEANUP_CONFIRMATION,
} from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";
import type { Notifier } from "@chorus/core";
import {
  buildDiagnosticPrompt,
  buildSelfHealPrompt,
  type DiagnosticsArgs,
  runDiagnostics,
  runSelfHeal,
  type Orchestrator,
} from "@chorus/orchestrator";
import { findSpec, SpecIngestor } from "@chorus/spec-ingest";
import { detectBackends } from "./backend-detect.js";

/** Injectable for tests: the function that runs the read-only diagnosis. */
export type DiagnoseFn = (args: DiagnosticsArgs) => Promise<DiagnosisResult>;
/** Injectable for tests: the function that runs the read-only self-heal analysis. */
export type SelfHealFn = (args: DiagnosticsArgs) => Promise<SelfHealResult>;

export interface ControllerDeps {
  db: ChorusDb;
  git: GitService;
  backends: BackendRegistry;
  orchestrator: Orchestrator;
  notifier: Notifier;
  bus: ChorusBus;
  config: Config;
  /** Backends/models detected on the host at startup. */
  detectedBackends: BackendInfo[];
  /** Override the diagnosis runner (tests inject a mock; defaults to runDiagnostics). */
  diagnose?: DiagnoseFn;
  /** Override the self-heal runner (tests inject a mock; defaults to runSelfHeal). */
  selfHeal?: SelfHealFn;
}

const DEFAULT_GROUND_RULES = [
  "Follow the project specification and the high-level expectations above.",
  "Write clear commit messages describing what changed and why.",
  "Prefer small, focused changes that keep each PR easy to review.",
];

const DEFAULT_ROLES: UpsertRoleInput[] = [
  {
    name: ORCHESTRATOR_ROLE,
    description:
      "Triages every ticket: decides whether to assign it to another agent, open a PR for the work, or close it. Routes work and gates PRs. Cannot be deleted.",
    allowed: ["read the repo", "assign tickets to other agents", "open PRs for approved work", "close tickets", "raise suggestions"],
    forbidden: ["write code directly"],
    allowedToolIds: ORCHESTRATOR_TOOLS,
    forbiddenToolIds: ["repo.modify", "repo.commit"],
    backendId: "codex",
  },
  {
    name: "software-dev",
    description: "Implements tickets end-to-end with tests, following the project spec.",
    allowed: ["read and write code", "run tests and builds", "create files", "refactor touched code"],
    forbidden: ["push to remote", "modify the main branch", "change CI secrets"],
    allowedToolIds: CODING_TOOLS,
    forbiddenToolIds: [],
    backendId: "codex",
  },
];

/**
 * Best-effort detection of the setup + verify commands for a freshly cloned
 * repo, so agents can build/test (the worktree starts with no deps installed).
 * Understands Node projects via package.json scripts; other stacks leave these
 * empty (the user can set them in Settings).
 *
 * When the repo has a `build` script, setup also builds — many repos (incl.
 * TS monorepos that resolve cross-package imports to gitignored `dist`) need a
 * build before tests/imports work, so a worktree that only `npm install`ed
 * would fail confusingly.
 */
export function detectCommands(localPath: string): {
  setupCommand: string | null;
  verifyCommands: string[];
} {
  const pkgPath = join(localPath, "package.json");
  if (!existsSync(pkgPath)) return { setupCommand: null, verifyCommands: [] };
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const hasBuild = !!scripts.build;
    const verify: string[] = [];
    if (hasBuild) verify.push("npm run build");
    if (scripts.test) verify.push("npm test");
    else if (scripts.lint) verify.push("npm run lint");
    return {
      setupCommand: hasBuild ? "npm install && npm run build" : "npm install",
      verifyCommands: verify,
    };
  } catch {
    return { setupCommand: "npm install", verifyCommands: [] };
  }
}

interface SafeAgentEvent {
  kind?: string;
  /** reasoning / message text */
  text?: string;
  /** command-event fields */
  command?: string;
  status?: string;
  exitCode?: number;
  /** log line */
  line?: string;
  /** quota_warning message */
  message?: string;
  /** file_change paths */
  files?: string[];
}

interface SafeEvent {
  type?: string;
  at?: number;
  projectId?: string;
  ticketId?: string;
  taskId?: string;
  role?: string;
  state?: string;
  ticketTitle?: string;
  title?: string;
  event?: SafeAgentEvent;
}

/**
 * Reduce an untrusted live-event to a bounded set of safe fields (no secrets/env).
 * Keeps the per-kind details the diagnostician needs (failed commands, log lines,
 * quota warnings, changed files) rather than only kind+text.
 */
function sanitizeEvent(e: unknown): SafeEvent {
  if (!e || typeof e !== "object") return {};
  const r = e as Record<string, unknown>;
  const out: SafeEvent = {};
  if (typeof r.type === "string") out.type = r.type;
  if (typeof r.at === "number") out.at = r.at;
  if (typeof r.projectId === "string") out.projectId = r.projectId;
  if (typeof r.ticketId === "string") out.ticketId = r.ticketId;
  if (typeof r.taskId === "string") out.taskId = r.taskId;
  if (typeof r.role === "string") out.role = r.role;
  if (typeof r.state === "string") out.state = r.state;
  if (typeof r.ticketTitle === "string") out.ticketTitle = r.ticketTitle.slice(0, 200);
  if (typeof r.title === "string") out.title = r.title.slice(0, 200);
  const ev = r.event as Record<string, unknown> | undefined;
  if (ev && typeof ev === "object") {
    const se: SafeAgentEvent = {};
    if (typeof ev.kind === "string") se.kind = ev.kind;
    if (typeof ev.text === "string") se.text = ev.text.slice(0, 500);
    if (typeof ev.command === "string") se.command = ev.command.slice(0, 300);
    if (typeof ev.status === "string") se.status = ev.status;
    if (typeof ev.exitCode === "number") se.exitCode = ev.exitCode;
    if (typeof ev.line === "string") se.line = ev.line.slice(0, 300);
    if (typeof ev.message === "string") se.message = ev.message.slice(0, 300);
    if (Array.isArray(ev.files))
      se.files = ev.files.filter((f): f is string => typeof f === "string").slice(0, 20);
    out.event = se;
  }
  return out;
}

/** Implements the commands the web layer issues. Owns project initialization. */
export class AppController implements ControlApi {
  private readonly ingestor: SpecIngestor;
  private backends: BackendInfo[];
  private readonly diagnose: DiagnoseFn;
  private readonly selfHeal: SelfHealFn;
  /** ticketIds with an "address PR comments" run in flight (one at a time each). */
  private readonly addressingPr = new Set<string>();

  constructor(private readonly deps: ControllerDeps) {
    this.ingestor = new SpecIngestor(deps.db);
    this.backends = deps.detectedBackends;
    this.diagnose = deps.diagnose ?? runDiagnostics;
    this.selfHeal = deps.selfHeal ?? runSelfHeal;
  }

  listBackends(): BackendInfo[] {
    return this.backends;
  }

  /** Backfill default agents (incl. the orchestrator) for all existing projects. */
  ensureProjectAgents(): void {
    for (const project of this.deps.db.listProjects()) {
      for (const role of DEFAULT_ROLES) this.seedRole(project.id, role);
    }
  }

  /**
   * Backfill auto-detected setup/verify commands for existing projects that
   * haven't been through command detection yet (created before it existed).
   * Runs once per project (gated by `commandsDetected`). Only fills in commands
   * for projects that have NONE — never overwrites commands a user (or a prior
   * manual config) already set, even when detection comes up empty.
   */
  backfillProjectCommands(): void {
    for (const project of this.deps.db.listProjects()) {
      if (project.commandsDetected) continue;
      const hasCommands = !!project.setupCommand || (project.verifyCommands?.length ?? 0) > 0;
      const detected = hasCommands ? null : detectCommands(project.localPath);
      this.deps.db.updateProject(project.id, {
        ...(detected && (detected.setupCommand || detected.verifyCommands.length > 0)
          ? { setupCommand: detected.setupCommand, verifyCommands: detected.verifyCommands }
          : {}),
        commandsDetected: true,
      });
      this.emitProject(project.id);
    }
  }

  /**
   * Re-install the pre-push hook for every existing project's clone. The hook
   * is generated deterministically and only written at project creation, so a
   * clone created by an older (buggy) generator keeps a stale/broken hook —
   * which silently breaks the PR-open push. Reinstalling on boot is idempotent
   * and cheap (one small file write per clone) and self-heals those hooks.
   */
  async reinstallPushGuards(): Promise<void> {
    for (const project of this.deps.db.listProjects()) {
      if (!existsSync(join(project.localPath, ".git"))) continue; // clone missing
      try {
        await this.deps.git.installPushGuard(project.localPath, [
          project.baseBranch,
          "main",
          "master",
        ]);
      } catch {
        /* best-effort; a bad hook shouldn't block startup */
      }
    }
  }

  /** Reject unknown tool ids or an id that is both allowed and forbidden. */
  private assertValidTools(input: { allowedToolIds?: string[]; forbiddenToolIds?: string[] }): void {
    const v = validateToolSelection(input.allowedToolIds ?? [], input.forbiddenToolIds ?? []);
    if (!v.ok) throw Object.assign(new Error(v.error), { statusCode: 400 });
  }

  upsertAgentTemplate(input: UpsertAgentTemplateInput): Promise<AgentTemplate> {
    this.assertValidTools(input);
    const existing = this.deps.db.getAgentTemplate(input.name);
    if (existing) {
      const updated: AgentTemplate = { ...existing, ...input };
      this.deps.db.updateAgentTemplate(updated);
      return Promise.resolve(updated);
    }
    const created: AgentTemplate = { id: newId("tmpl"), createdAt: Date.now(), ...input };
    this.deps.db.insertAgentTemplate(created);
    return Promise.resolve(created);
  }

  deleteAgentTemplate(name: string): Promise<void> {
    this.deps.db.deleteAgentTemplate(name);
    return Promise.resolve();
  }

  async refreshBackends(): Promise<BackendInfo[]> {
    this.backends = await detectBackends();
    return this.backends;
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = newId("proj");
    const localPath = join(this.deps.config.dataDir, "repos", id);
    const project: Project = {
      id,
      repoUrl: input.repoUrl,
      localPath,
      baseBranch: input.baseBranch?.trim() || "main",
      specPath: null,
      expectations: "",
      groundRules: DEFAULT_GROUND_RULES,
      setupCommand: null,
      verifyCommands: [],
      commandsDetected: false,
      status: "initializing",
      runState: "running",
      idleIdeation: false,
      idleIdeationCount: 1,
      createdAt: Date.now(),
    };
    this.deps.db.insertProject(project);
    this.emitProject(id);
    // Initialize in the background so the UI returns immediately.
    void this.initProject(project, input.specText, input.baseBranch?.trim() || undefined);
    return project;
  }

  private async initProject(project: Project, specText?: string, baseOverride?: string): Promise<void> {
    try {
      await this.deps.git.clone(project.repoUrl, project.localPath);
      const baseBranch = baseOverride ?? (await this.deps.git.detectDefaultBranch(project.localPath));
      await this.deps.git.installPushGuard(project.localPath, [baseBranch, "main", "master"]);
      const { setupCommand, verifyCommands } = detectCommands(project.localPath);
      this.deps.db.updateProject(project.id, {
        baseBranch,
        setupCommand,
        verifyCommands,
        commandsDetected: true,
      });

      for (const role of DEFAULT_ROLES) this.seedRole(project.id, role);

      if (specText) {
        await this.writeSpec(project, specText);
      }
      // findSpec falls back to README.md as a last resort when no docs/SPEC.md exists.
      const specPath = findSpec(project.localPath);

      if (specPath) {
        this.deps.db.updateProject(project.id, { specPath, status: "ready" });
        await this.ingestProject({ ...project, specPath, baseBranch });
      } else {
        this.deps.db.updateProject(project.id, { status: "needs_spec" });
        await this.deps.notifier.notify({
          kind: "needs_review",
          projectId: project.id,
          title: "Project needs a spec",
          body: `${project.repoUrl} has no docs/SPEC.md — provide one to start work.`,
          at: Date.now(),
        });
      }
      this.emitProject(project.id);
    } catch (err) {
      this.deps.db.updateProject(project.id, { status: "error" });
      this.emitProject(project.id);
      await this.deps.notifier.notify({
        kind: "error",
        projectId: project.id,
        title: "Project init failed",
        body: `${project.repoUrl}: ${String(err)}`,
        at: Date.now(),
      });
    }
  }

  async provideSpec(projectId: string, specText: string): Promise<void> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    await this.writeSpec(project, specText);
    const specPath = "docs/SPEC.md";
    this.deps.db.updateProject(projectId, { specPath, status: "ready" });
    await this.ingestProject({ ...project, specPath });
    this.emitProject(projectId);
  }

  readProjectSpec(projectId: string): Promise<{ path: string | null; content: string | null }> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    const path = project.specPath ?? null;
    if (!path) return Promise.resolve({ path: null, content: null });
    const full = join(project.localPath, path);
    if (!existsSync(full)) return Promise.resolve({ path, content: null });
    try {
      return Promise.resolve({ path, content: readFileSync(full, "utf8") });
    } catch {
      return Promise.resolve({ path, content: null });
    }
  }

  private async writeSpec(project: Project, specText: string): Promise<void> {
    const rel = "docs/SPEC.md";
    const full = join(project.localPath, rel);
    await mkdir(join(project.localPath, "docs"), { recursive: true });
    await writeFile(full, specText, "utf8");
    await this.deps.git.commitFile(project.localPath, rel, specText, "chorus: add project spec");
  }

  private async ingestProject(project: Project): Promise<void> {
    const artifactsDir = join(this.deps.config.dataDir, "ingest", project.id);
    const tickets = await this.ingestor.ingest(project, { artifactsDir });
    for (const t of tickets) {
      this.deps.bus.emit({ type: "ticket_changed", projectId: project.id, ticketId: t.id, at: Date.now() });
    }
  }

  updateProjectSettings(projectId: string, patch: ProjectSettingsInput): Promise<Project> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    this.deps.db.updateProject(projectId, {
      ...(patch.baseBranch !== undefined ? { baseBranch: patch.baseBranch.trim() || "main" } : {}),
      ...(patch.expectations !== undefined ? { expectations: patch.expectations } : {}),
      ...(patch.groundRules !== undefined ? { groundRules: patch.groundRules } : {}),
      ...(patch.setupCommand !== undefined ? { setupCommand: patch.setupCommand.trim() || null } : {}),
      ...(patch.verifyCommands !== undefined ? { verifyCommands: patch.verifyCommands } : {}),
      ...(patch.idleIdeation !== undefined ? { idleIdeation: patch.idleIdeation } : {}),
      ...(patch.idleIdeationCount !== undefined
        ? { idleIdeationCount: Math.min(10, Math.max(1, Math.floor(patch.idleIdeationCount) || 1)) }
        : {}),
    });
    this.emitProject(projectId);
    return Promise.resolve(this.deps.db.getProject(projectId)!);
  }

  async setProjectRunState(projectId: string, state: ProjectRunState): Promise<Project> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    this.deps.db.updateProject(projectId, { runState: state });

    if (state === "stopped") {
      // Stop: halt new dispatch (gated in the loop) AND stop running agents.
      await this.deps.orchestrator.stopProjectAgents(projectId);
    } else if (state === "running") {
      // Start: re-open (to the orchestrator) any tickets left in_progress with no
      // live agent (e.g. interrupted by a prior Stop) so they get re-triaged.
      const running = new Set(this.deps.orchestrator.runningTaskIds()); // ticket ids
      for (const ticket of this.deps.db.listTickets(projectId)) {
        if (ticket.status !== "in_progress") continue;
        if (!running.has(ticket.id))
          this.deps.db.updateTicket(ticket.id, { status: "open", roleName: ORCHESTRATOR_ROLE });
      }
      void this.deps.orchestrator.tick();
    }
    // "paused": just gate new dispatch; running agents finish on their own.

    this.emitProject(projectId);
    return this.deps.db.getProject(projectId)!;
  }

  addTicket(projectId: string, input: CreateTicketInput): Promise<Ticket> {
    const now = Date.now();
    // Honor an explicitly-proposed role only if it's a real project role;
    // otherwise the orchestrator triages it (the default for manual tickets).
    const roleName =
      input.roleName && this.deps.db.getRole(projectId, input.roleName)
        ? input.roleName
        : ORCHESTRATOR_ROLE;
    const ticket: Ticket = {
      id: newId("tkt"),
      projectId,
      title: input.title,
      body: input.body,
      status: "open",
      roleName,
      priority: input.priority ?? 0,
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
    if (input.fromDiagnostic) {
      // Audit trail: record that this ticket was filed from a Debug Traces diagnosis.
      this.deps.db.insertTicketEvent({
        id: newId("te"),
        projectId,
        ticketId: ticket.id,
        actor: "system",
        kind: "note",
        message: "Filed from Trace Diagnosis.",
        createdAt: now,
      });
    }
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId: ticket.id, at: now });
    void this.deps.orchestrator.tick();
    return Promise.resolve(ticket);
  }

  updateTicket(projectId: string, ticketId: string, patch: UpdateTicketInput): Promise<Ticket> {
    const ticket = this.deps.db.getTicket(ticketId);
    if (!ticket || ticket.projectId !== projectId) throw new Error("ticket not found");
    this.assertTicketIdle(ticketId, "modify");
    this.deps.db.updateTicket(ticketId, {
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.body !== undefined ? { body: patch.body } : {}),
      ...(patch.roleName !== undefined ? { roleName: patch.roleName } : {}),
      ...(patch.priority !== undefined ? { priority: patch.priority } : {}),
      ...(patch.reopen ? { status: "open" as const } : {}),
    });
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
    if (patch.reopen) {
      // Re-attempt the PR directly rather than re-triaging stale failures.
      this.deps.orchestrator.requestReattempt(ticketId);
      void this.deps.orchestrator.tick();
    }
    return Promise.resolve(this.deps.db.getTicket(ticketId)!);
  }

  setTicketStarred(projectId: string, ticketId: string, starred: boolean): Promise<Ticket> {
    const ticket = this.deps.db.getTicket(ticketId);
    if (!ticket || ticket.projectId !== projectId) throw new Error("ticket not found");
    // Starring is display-only metadata — allowed even while the agent runs.
    this.deps.db.updateTicket(ticketId, { starred });
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
    return Promise.resolve(this.deps.db.getTicket(ticketId)!);
  }

  addressPrComments(projectId: string, ticketId: string): Promise<{ started: boolean }> {
    const ticket = this.deps.db.getTicket(ticketId);
    if (!ticket || ticket.projectId !== projectId) throw new Error("ticket not found");
    if (!ticket.prNumber && !ticket.prUrl) {
      throw Object.assign(new Error("This ticket has no pull request."), { statusCode: 400 });
    }
    if (!ticket.branch) {
      throw Object.assign(new Error("This ticket has no work branch."), { statusCode: 400 });
    }
    if (this.addressingPr.has(ticketId)) {
      throw Object.assign(new Error("Already addressing PR comments for this ticket."), {
        statusCode: 409,
      });
    }
    if (this.deps.orchestrator.runningTaskIds().includes(ticketId)) {
      throw Object.assign(new Error("Cannot address PR comments while an agent is running."), {
        statusCode: 409,
      });
    }
    this.addressingPr.add(ticketId);
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
    void this.runAddressPrComments(projectId, ticketId)
      .catch((err) => {
        this.trail(projectId, ticketId, `Address PR comments failed: ${String(err)}`);
        void this.deps.notifier
          .notify({
            kind: "error",
            projectId,
            title: "Address PR comments failed",
            body: `${this.deps.db.getTicket(ticketId)?.title ?? ticketId}: ${String(err)}`,
            at: Date.now(),
          })
          .catch(() => {});
      })
      .finally(() => {
        this.addressingPr.delete(ticketId);
        this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
      });
    return Promise.resolve({ started: true });
  }

  private async runAddressPrComments(projectId: string, ticketId: string): Promise<void> {
    const project = this.deps.db.getProject(projectId);
    const ticket = this.deps.db.getTicket(ticketId);
    if (!project || !ticket || !ticket.branch) return;
    const prRef = ticket.prNumber != null ? String(ticket.prNumber) : (ticket.prUrl ?? ticket.branch);

    this.trail(projectId, ticketId, "Addressing PR review comments…");
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });

    const comments = await this.deps.git.prReviewComments(project.localPath, prRef);
    if (!comments.trim()) {
      this.trail(projectId, ticketId, "No PR review comments to address.");
      return;
    }

    // Re-materialize the ticket's worktree on its existing branch if needed.
    const worktreePath =
      ticket.worktreePath ?? join(this.deps.config.dataDir, "worktrees", projectId, ticketId);
    await this.deps.git.ensureBranchWorktree(project.localPath, worktreePath, ticket.branch);
    if (!ticket.worktreePath) this.deps.db.updateTicket(ticketId, { worktreePath });

    const role = ticket.roleName ? this.deps.db.getRole(projectId, ticket.roleName) : undefined;
    const backend =
      (role?.backendId ? this.deps.backends.get(role.backendId) : undefined) ??
      this.deps.backends.get("codex");
    if (!backend) throw new Error("no backend available to address PR comments");
    await backend.prepare?.().catch(() => null);

    const taskId = newId("task");
    const result = await this.runAgentInWorktree(backend, {
      taskId,
      projectId,
      ticketId,
      ticketTitle: ticket.title,
      roleName: ticket.roleName ?? "orchestrator",
      worktreePath,
      model: role?.model ?? this.deps.config.agent.model,
      prompt: this.buildAddressPrPrompt(project, ticket, comments),
    });

    const summary = result.payload?.summary?.trim() || "Reviewed the PR comments.";
    const notes = result.payload?.notes?.trim();
    const report = notes ? `${summary}\n\n${notes}` : summary;

    // Commit + push any edits the agent made, then report on the PR.
    const head = await this.deps.git.commitAll(worktreePath, "chorus: address PR review comments");
    if (head) await this.deps.git.pushBranch(project.localPath, ticket.branch);

    const prefix = head ? "🤖 Addressed review comments." : "🤖 Reviewed the comments (no code changes).";
    await this.deps.git.commentOnPr(project.localPath, prRef, `${prefix}\n\n${report}`);

    this.trail(
      projectId,
      ticketId,
      `Addressed PR comments${head ? " (pushed changes)" : " (no changes)"}: ${summary}`,
    );
    await this.deps.notifier
      .notify({
        kind: "needs_review",
        projectId,
        title: "PR comments addressed",
        body: `${ticket.title}: ${summary}`,
        at: Date.now(),
      })
      .catch(() => {});
  }

  /** Run one agent process to completion in a worktree, streaming events to the bus. */
  private async runAgentInWorktree(
    backend: AIBackend,
    args: {
      taskId: string;
      projectId: string;
      ticketId: string;
      ticketTitle: string;
      roleName: string;
      worktreePath: string;
      model?: string;
      prompt: string;
    },
  ): Promise<AgentResult> {
    const handle = backend.startRun({
      taskId: args.taskId,
      prompt: args.prompt,
      worktreePath: args.worktreePath,
      model: args.model,
      maxWallClockMs: this.deps.config.agent.maxWallClockMs,
      idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
      artifactsDir: join(this.deps.config.dataDir, "address-pr", args.projectId, args.taskId),
    });
    const drain = (async () => {
      for await (const ev of handle.events) {
        this.deps.bus.emit({
          type: "agent_event",
          projectId: args.projectId,
          taskId: args.taskId,
          role: args.roleName,
          ticketId: args.ticketId,
          ticketTitle: args.ticketTitle,
          event: ev,
          at: Date.now(),
        });
      }
    })();
    const [result] = await Promise.all([handle.result, drain]);
    return result;
  }

  private buildAddressPrPrompt(
    project: Project,
    ticket: Ticket,
    comments: string,
  ): string {
    const L: string[] = [];
    L.push("# Address pull-request review comments");
    L.push(
      "You are working in this ticket's git worktree, checked out on the PR branch. Reviewers left the comments below on the open pull request.",
    );
    L.push("");
    L.push("## What to do");
    L.push("- For each comment you AGREE with, edit the code in this worktree to address it.");
    L.push("- For any comment you DISAGREE with, do NOT change the code for it; instead explain why in your summary.");
    L.push("- Keep changes focused and consistent with the surrounding code.");
    L.push("- Do NOT run `git commit`, `git push`, or `gh` — Chorus commits, pushes, and comments for you afterward.");
    L.push("- In the structured output: `summary` is a concise markdown report that will be posted as a PR comment. It MUST list, per comment, whether you addressed it (and how) or disagreed (and why). Put longer rationale in `notes`. Set `filesChanged` to the files you edited.");
    L.push("");
    if (project.expectations?.trim()) {
      L.push("## Project expectations");
      L.push(project.expectations.trim());
      L.push("");
    }
    L.push("## Ticket");
    L.push(`- ${ticket.title}`);
    if (ticket.body.trim()) L.push(ticket.body.trim());
    L.push("");
    L.push("## Review comments to address");
    L.push(comments);
    return L.join("\n");
  }

  /** Append a system note to a ticket's activity trail and broadcast it. */
  private trail(projectId: string, ticketId: string, message: string): void {
    this.deps.db.insertTicketEvent({
      id: newId("te"),
      projectId,
      ticketId,
      actor: "system",
      kind: "note",
      message,
      createdAt: Date.now(),
    });
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
  }

  /**
   * Reorder a project's tickets by reassigning priorities so the given order
   * (top→bottom) is preserved (top row = highest priority). Tickets not listed
   * keep their relative order below the listed ones. Safe to call while an
   * agent runs — priority only affects future dispatch ordering.
   */
  reorderTickets(projectId: string, orderedIds: string[]): Promise<void> {
    const all = this.deps.db.listTickets(projectId);
    const known = new Set(all.map((t) => t.id));
    const ordered = orderedIds.filter((id) => known.has(id));
    const rest = all.filter((t) => !ordered.includes(t.id)).map((t) => t.id);
    const finalOrder = [...ordered, ...rest];
    // Assign descending priorities; highest at the top so `priority DESC` sorts match.
    const top = finalOrder.length;
    finalOrder.forEach((id, i) => {
      this.deps.db.updateTicket(id, { priority: top - i });
    });
    this.emitProject(projectId);
    return Promise.resolve();
  }

  deleteTicket(projectId: string, ticketId: string): Promise<void> {
    const ticket = this.deps.db.getTicket(ticketId);
    if (!ticket || ticket.projectId !== projectId) throw new Error("ticket not found");
    this.assertTicketIdle(ticketId, "delete");
    this.deps.db.deleteTicket(ticketId);
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId, at: Date.now() });
    return Promise.resolve();
  }

  async cleanupTickets(projectId: string, input: CleanupTicketsInput): Promise<CleanupTicketsResult> {
    if (input?.confirmation !== TICKET_CLEANUP_CONFIRMATION) {
      throw Object.assign(new Error(`Type ${TICKET_CLEANUP_CONFIRMATION} to clean up tickets.`), {
        statusCode: 400,
      });
    }

    const project = this.deps.db.getProject(projectId);
    if (!project) throw new Error("project not found");
    const tickets = this.deps.db.listTickets(projectId);
    const running = new Set(this.deps.orchestrator.runningTaskIds());
    const runningTicket = tickets.find((ticket) => running.has(ticket.id));
    if (runningTicket) {
      throw Object.assign(new Error("Cannot clean up tickets while an agent is running."), {
        statusCode: 409,
      });
    }

    const removeBranches = !!input.removeBranches;
    const removePullRequests = !!input.removePullRequests;
    let closedPullRequests = 0;
    let removedBranches = 0;

    if (removePullRequests || removeBranches) {
      const branchCleanup = new Set<string>();
      for (const ticket of tickets) {
        if (removePullRequests) {
          const prRef = ticket.prUrl ?? (ticket.prNumber != null ? String(ticket.prNumber) : ticket.branch);
          if (prRef && (await this.deps.git.closePullRequest(project.localPath, prRef))) {
            closedPullRequests += 1;
          }
        }
        if (removeBranches) {
          if (ticket.worktreePath) {
            try {
              await this.deps.git.removeWorktree(project.localPath, ticket.worktreePath);
            } catch {
              /* Missing/stale worktrees should not block branch cleanup. */
            }
          }
          for (const branch of this.ticketBranches(ticket)) {
            const trimmed = branch.trim();
            if (this.canDeleteCleanupBranch(trimmed, project.baseBranch)) branchCleanup.add(trimmed);
          }
        }
      }

      for (const branch of branchCleanup) {
        if (await this.deps.git.deleteBranch(project.localPath, branch)) removedBranches += 1;
      }
    }

    for (const ticket of tickets) {
      this.deps.db.deleteTicket(ticket.id);
      this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId: ticket.id, at: Date.now() });
    }
    this.emitProject(projectId);
    return { deletedTickets: tickets.length, closedPullRequests, removedBranches };
  }

  private ticketBranches(ticket: Ticket): string[] {
    const branches = new Set<string>();
    if (ticket.branch) branches.add(ticket.branch);
    for (const task of this.deps.db.listTasksForTicket(ticket.id)) {
      if (task.branch) branches.add(task.branch);
    }
    return [...branches];
  }

  private canDeleteCleanupBranch(branch: string, baseBranch: string): boolean {
    return (
      branch.startsWith("chorus/") &&
      branch !== baseBranch.trim() &&
      branch !== "main" &&
      branch !== "master"
    );
  }

  /** Reject mutations to a ticket whose agent is actively running. */
  private assertTicketIdle(ticketId: string, action: string): void {
    if (this.deps.orchestrator.runningTaskIds().includes(ticketId)) {
      throw Object.assign(new Error(`Cannot ${action} a ticket while its agent is running.`), {
        statusCode: 409,
      });
    }
  }

  upsertRole(projectId: string, input: UpsertRoleInput): Promise<Role> {
    if (!this.deps.db.getProject(projectId)) {
      throw Object.assign(new Error(`No such project: ${projectId}`), { statusCode: 404 });
    }
    this.assertValidTools(input);
    const existing = this.deps.db.getRole(projectId, input.name);
    if (existing) {
      const updated: Role = { ...existing, ...input };
      this.deps.db.updateRole(updated);
      this.emitProject(projectId);
      return Promise.resolve(updated);
    }
    const role = this.seedRole(projectId, input);
    this.emitProject(projectId);
    return Promise.resolve(role);
  }

  /** Create/update a project role from a gallery template, copying tool permissions. */
  applyTemplate(projectId: string, templateRef: string | ApplyAgentTemplateInput): Promise<Role> {
    const ref = typeof templateRef === "string" ? { name: templateRef } : templateRef;
    const template = this.resolveTemplateRef(ref);
    if (!template) {
      const label = ref.id ?? ref.name ?? "(missing name)";
      throw Object.assign(new Error(`No such agent template: ${label}`), { statusCode: 404 });
    }
    return this.upsertRole(projectId, templateToRoleInput(template));
  }

  private resolveTemplateRef(ref: ApplyAgentTemplateInput): AgentTemplate | ReturnType<typeof getBuiltInAgentTemplate> {
    if (ref.source === "builtin") return getBuiltInAgentTemplate({ id: ref.id, name: ref.name });
    if (ref.source === "custom") return ref.name ? this.deps.db.getAgentTemplate(ref.name) : undefined;

    // Backward compatibility for old clients: a bare name means "custom if it
    // exists, otherwise built-in". New dashboard calls send source explicitly.
    const custom = ref.name ? this.deps.db.getAgentTemplate(ref.name) : undefined;
    return custom ?? getBuiltInAgentTemplate({ id: ref.id, name: ref.name });
  }

  deleteRole(projectId: string, name: string): Promise<void> {
    if (name === ORCHESTRATOR_ROLE) {
      throw Object.assign(new Error("The orchestrator agent cannot be deleted."), {
        statusCode: 409,
      });
    }
    this.deps.db.deleteRole(projectId, name);
    this.emitProject(projectId);
    return Promise.resolve();
  }

  dismissSuggestion(projectId: string, suggestionId: string): Promise<void> {
    this.deps.db.setSuggestionStatus(suggestionId, "dismissed");
    this.emitProject(projectId);
    return Promise.resolve();
  }

  // ---- Debug Traces (read-only diagnostics) ----
  async runDebugTraces(
    projectId: string,
    ticketId: string | null,
    liveEvents: unknown[],
  ): Promise<DiagnosisResult> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw Object.assign(new Error(`No such project: ${projectId}`), { statusCode: 404 });
    // Validate ticket ownership before building context — never diagnose another
    // project's ticket via this project's URL (data isolation), and don't waste a
    // model run on a non-existent ticket.
    if (ticketId) {
      const t = this.deps.db.getTicket(ticketId);
      if (!t || t.projectId !== projectId) {
        throw Object.assign(new Error(`No such ticket: ${ticketId}`), { statusCode: 404 });
      }
    }
    const context = this.buildTraceContext(project, ticketId, liveEvents);
    const workerRoleNames = this.deps.db
      .listRoles(projectId)
      .filter((r) => r.name !== ORCHESTRATOR_ROLE)
      .map((r) => r.name);
    const prompt = buildDiagnosticPrompt({
      scope: ticketId ? "ticket" : "project",
      context,
      workerRoleNames,
    });
    const ticket = ticketId ? this.deps.db.getTicket(ticketId) : undefined;
    const cwd =
      ticket?.worktreePath && existsSync(ticket.worktreePath) ? ticket.worktreePath : project.localPath;
    const artifactsDir = join(
      this.deps.config.dataDir,
      "diagnostics",
      projectId,
      ticketId ?? "project",
      newId("d"),
    );
    return this.diagnose({
      cwd,
      artifactsDir,
      prompt,
      model: this.deps.config.diagnostics?.model ?? this.deps.config.agent.model,
      maxWallClockMs: this.deps.config.agent.maxWallClockMs,
      idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
    });
  }

  async selfHealAnalyze(
    projectId: string,
    ticketId: string,
    liveEvents: unknown[],
  ): Promise<SelfHealResult> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw Object.assign(new Error(`No such project: ${projectId}`), { statusCode: 404 });
    const ticket = this.deps.db.getTicket(ticketId);
    if (!ticket || ticket.projectId !== projectId) {
      throw Object.assign(new Error(`No such ticket: ${ticketId}`), { statusCode: 404 });
    }
    const context = this.buildTraceContext(project, ticketId, liveEvents);
    const roles = this.deps.db.listRoles(projectId).map((r) => ({
      name: r.name,
      description: r.description,
      allowed: r.allowed,
      forbidden: r.forbidden,
      allowedToolIds: r.allowedToolIds,
      forbiddenToolIds: r.forbiddenToolIds,
      backendId: r.backendId,
      model: r.model,
    }));
    const prompt = buildSelfHealPrompt({ context, roles, tools: [...TOOL_CATALOG] });
    const cwd =
      ticket.worktreePath && existsSync(ticket.worktreePath) ? ticket.worktreePath : project.localPath;
    const artifactsDir = join(this.deps.config.dataDir, "self-heal", projectId, ticketId, newId("sh"));
    const result = await this.selfHeal({
      cwd,
      artifactsDir,
      prompt,
      model: this.deps.config.diagnostics?.model ?? this.deps.config.agent.model,
      maxWallClockMs: this.deps.config.agent.maxWallClockMs,
      idleTimeoutMs: this.deps.config.agent.idleTimeoutMs,
    });
    // Stamp stable ids so the UI can accept/reject each proposal independently.
    result.proposals = result.proposals.map((p, i) => ({ ...p, id: `p${i}` }));
    return result;
  }

  async applySelfHealProposal(projectId: string, proposal: SelfHealProposal): Promise<void> {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw Object.assign(new Error(`No such project: ${projectId}`), { statusCode: 404 });
    if (!proposal || typeof proposal !== "object") {
      throw Object.assign(new Error("proposal required"), { statusCode: 400 });
    }
    if (proposal.kind === "role") {
      const name = proposal.roleName?.trim();
      if (!name) throw Object.assign(new Error("roleName required for a role proposal"), { statusCode: 400 });
      const existing = this.deps.db.getRole(projectId, name);
      if (!existing) throw Object.assign(new Error(`No such role: ${name}`), { statusCode: 404 });
      // Merge only the fields the proposal actually populated; empty = keep current.
      const proposedAllowedTools = proposal.allowedToolIds?.length ? proposal.allowedToolIds : null;
      const proposedForbiddenTools = proposal.forbiddenToolIds?.length ? proposal.forbiddenToolIds : null;
      let allowedToolIds = proposedAllowedTools ?? existing.allowedToolIds;
      let forbiddenToolIds = proposedForbiddenTools ?? existing.forbiddenToolIds;
      // A tool moved into one list must not linger in the retained opposite list,
      // or validateToolSelection would reject the accept (a tool can't be both).
      if (proposedForbiddenTools) {
        const deny = new Set(proposedForbiddenTools);
        allowedToolIds = allowedToolIds.filter((id) => !deny.has(id));
      }
      if (proposedAllowedTools) {
        const grant = new Set(proposedAllowedTools);
        forbiddenToolIds = forbiddenToolIds.filter((id) => !grant.has(id));
      }
      const input: UpsertRoleInput = {
        name: existing.name,
        description: proposal.description?.trim() ? proposal.description : existing.description,
        allowed: proposal.allowed?.length ? proposal.allowed : existing.allowed,
        forbidden: proposal.forbidden?.length ? proposal.forbidden : existing.forbidden,
        allowedToolIds,
        forbiddenToolIds,
        backendId: existing.backendId,
        model: proposal.model?.trim() ? proposal.model : existing.model,
      };
      await this.upsertRole(projectId, input);
      return;
    }
    if (proposal.kind === "expectations") {
      if (proposal.expectations === undefined) {
        throw Object.assign(new Error("expectations required for an expectations proposal"), {
          statusCode: 400,
        });
      }
      await this.updateProjectSettings(projectId, { expectations: proposal.expectations });
      return;
    }
    if (proposal.kind === "ground_rules") {
      if (!proposal.groundRules) {
        throw Object.assign(new Error("groundRules required for a ground_rules proposal"), {
          statusCode: 400,
        });
      }
      await this.updateProjectSettings(projectId, { groundRules: proposal.groundRules });
      return;
    }
    throw Object.assign(new Error(`Unknown proposal kind: ${String((proposal as { kind?: string }).kind)}`), {
      statusCode: 400,
    });
  }

  /** Bounded, sanitized trace context for the diagnostician (no secrets/env/raw logs). */
  private buildTraceContext(project: Project, ticketId: string | null, liveEvents: unknown[]): unknown {
    const events = (Array.isArray(liveEvents) ? liveEvents : [])
      .slice(0, 200)
      .map((raw) => sanitizeEvent((raw as { e?: unknown })?.e ?? raw));
    const meta = {
      id: project.id,
      repoUrl: project.repoUrl,
      baseBranch: project.baseBranch,
      status: project.status,
      runState: project.runState,
      setupCommand: project.setupCommand,
      verifyCommands: project.verifyCommands,
      expectations: project.expectations.slice(0, 2000),
      groundRules: project.groundRules,
    };
    const running = this.deps.orchestrator.runningTaskIds();

    if (ticketId) {
      const ticket = this.deps.db.getTicket(ticketId);
      const ticketEvents = this.deps.db
        .listTicketEvents(ticketId)
        .slice(-100)
        .map((e) => ({ actor: e.actor, kind: e.kind, message: e.message.slice(0, 500), createdAt: e.createdAt }));
      const tasks = this.deps.db.listTasksForTicket(ticketId).map((t) => ({
        id: t.id,
        state: t.state,
        attempt: t.attempt,
        branch: t.branch,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      }));
      const taskIds = new Set(tasks.map((t) => t.id));
      const journal = this.deps.db
        .listAttemptJournal(ticketId)
        .slice(-20)
        .map((j) => ({
          attempt: j.attempt,
          verifyPassed: j.verifyPassed,
          diagnosis: j.diagnosis?.slice(0, 500) ?? null,
          nextAction: j.nextAction,
          proof: j.proof?.slice(0, 200) ?? null,
        }));
      const prs = this.deps.db
        .listPullRequests(project.id)
        .filter((p) => p.ticketId === ticketId)
        .map((p) => ({ number: p.number, state: p.state, url: p.url }));
      const relevant = events.filter(
        (e) => !e.ticketId || e.ticketId === ticketId || (e.taskId != null && taskIds.has(e.taskId)),
      );
      return {
        scope: "ticket",
        project: meta,
        runningTaskIds: running,
        ticket: ticket
          ? {
              id: ticket.id,
              title: ticket.title,
              status: ticket.status,
              roleName: ticket.roleName,
              priority: ticket.priority,
              branch: ticket.branch,
              prUrl: ticket.prUrl,
              body: ticket.body.slice(0, 1000),
            }
          : null,
        tasks,
        ticketEvents,
        attemptJournal: journal,
        pullRequests: prs,
        liveEvents: relevant,
      };
    }

    const tickets = this.deps.db
      .listTickets(project.id)
      .map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, roleName: t.roleName }));
    const ticketEvents = this.deps.db
      .listProjectTicketEvents(project.id, 100)
      .map((e) => ({
        ticketId: e.ticketId,
        actor: e.actor,
        kind: e.kind,
        message: e.message.slice(0, 400),
        createdAt: e.createdAt,
      }));
    const journal = this.deps.db
      .listProjectAttemptJournal(project.id, 30)
      .map((j) => ({
        ticketId: j.ticketId,
        attempt: j.attempt,
        verifyPassed: j.verifyPassed,
        diagnosis: j.diagnosis?.slice(0, 300) ?? null,
        nextAction: j.nextAction,
      }));
    const prs = this.deps.db
      .listPullRequests(project.id, 20)
      .map((p) => ({ ticketId: p.ticketId, number: p.number, state: p.state }));
    return {
      scope: "project",
      project: meta,
      runningTaskIds: running,
      tickets,
      ticketEvents,
      attemptJournal: journal,
      pullRequests: prs,
      liveEvents: events,
    };
  }

  private seedRole(projectId: string, input: UpsertRoleInput): Role {
    const existing = this.deps.db.getRole(projectId, input.name);
    if (existing) return existing;
    const role: Role = { id: newId("role"), projectId, ...input };
    this.deps.db.insertRole(role);
    return role;
  }

  startOrchestrator(): void {
    this.deps.orchestrator.start();
  }
  pauseOrchestrator(): void {
    this.deps.orchestrator.pause();
  }
  stopOrchestrator(): Promise<void> {
    return this.deps.orchestrator.stop();
  }
  orchestratorState() {
    return this.deps.orchestrator.getState();
  }
  runningTaskIds(): string[] {
    return this.deps.orchestrator.runningTaskIds();
  }
  addressingPrTicketIds(): string[] {
    return [...this.addressingPr];
  }

  private emitProject(projectId: string): void {
    this.deps.bus.emit({ type: "project_changed", projectId, at: Date.now() });
  }
}
