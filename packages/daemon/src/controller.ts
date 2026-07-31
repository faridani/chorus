import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackendRegistry } from "@chorus/backends";
import {
  type AgentTemplate,
  type BackendInfo,
  type ChorusBus,
  type CommitLogEntry,
  type Config,
  type ControlApi,
  type CreateProjectInput,
  type CreateTicketInput,
  newId,
  ORCHESTRATOR_ROLE,
  type Project,
  type ProjectRunState,
  type ProjectSettingsInput,
  type UpsertAgentTemplateInput,
  type Role,
  type Ticket,
  type UpdateTicketInput,
  type UpsertRoleInput,
} from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";
import type { Notifier } from "@chorus/core";
import type { Orchestrator } from "@chorus/orchestrator";
import { findSpec, SpecIngestor } from "@chorus/spec-ingest";
import { detectBackends } from "./backend-detect.js";

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
}

const DEFAULT_GROUND_RULES = [
  "Follow the project specification and the high-level expectations above.",
  "Write clear commit messages describing what changed and why.",
  "Prefer small, focused changes that keep the integration branch releasable.",
];

const DEFAULT_ROLES: UpsertRoleInput[] = [
  {
    name: ORCHESTRATOR_ROLE,
    description:
      "Triages every ticket: decides whether to assign it to another agent, merge the work, or close it. Routes work and gates merges. Cannot be deleted.",
    allowed: ["read the repo", "assign tickets to other agents", "merge approved work", "close tickets", "raise suggestions"],
    forbidden: ["write code directly"],
    backendId: "codex",
  },
  {
    name: "software-dev",
    description: "Implements tickets end-to-end with tests, following the project spec.",
    allowed: ["read and write code", "run tests and builds", "create files", "refactor touched code"],
    forbidden: ["push to remote", "modify the main branch", "change CI secrets"],
    backendId: "codex",
  },
];

/** Implements the commands the web layer issues. Owns project initialization. */
export class AppController implements ControlApi {
  private readonly ingestor: SpecIngestor;
  private backends: BackendInfo[];

  constructor(private readonly deps: ControllerDeps) {
    this.ingestor = new SpecIngestor(deps.db);
    this.backends = deps.detectedBackends;
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

  upsertAgentTemplate(input: UpsertAgentTemplateInput): Promise<AgentTemplate> {
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
      integrationBranch: this.deps.config.integrationBranch,
      baseBranch: input.baseBranch?.trim() || "main",
      specPath: null,
      expectations: "",
      groundRules: DEFAULT_GROUND_RULES,
      status: "initializing",
      runState: "running",
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
      await this.deps.git.ensureIntegrationBranch(
        project.localPath,
        baseBranch,
        project.integrationBranch,
      );
      await this.deps.git.installPushGuard(project.localPath, [baseBranch, "main", "master"]);
      this.deps.db.updateProject(project.id, { baseBranch });

      for (const role of DEFAULT_ROLES) this.seedRole(project.id, role);

      if (specText) {
        await this.writeSpec(project, specText);
      }
      let specPath = findSpec(project.localPath);
      if (specPath === "README.md" && !specText) specPath = "README.md"; // README is a last resort

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
    const ticket: Ticket = {
      id: newId("tkt"),
      projectId,
      title: input.title,
      body: input.body,
      status: "open",
      // Every ticket first goes to the orchestrator agent, which triages it.
      roleName: ORCHESTRATOR_ROLE,
      priority: input.priority ?? 0,
      source: "manual",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insertTicket(ticket);
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
    if (patch.reopen) void this.deps.orchestrator.tick();
    return Promise.resolve(this.deps.db.getTicket(ticketId)!);
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

  /** Reject mutations to a ticket whose agent is actively running. */
  private assertTicketIdle(ticketId: string, action: string): void {
    if (this.deps.orchestrator.runningTaskIds().includes(ticketId)) {
      throw Object.assign(new Error(`Cannot ${action} a ticket while its agent is running.`), {
        statusCode: 409,
      });
    }
  }

  upsertRole(projectId: string, input: UpsertRoleInput): Promise<Role> {
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

  async approveToMain(projectId: string): Promise<{ ok: boolean; message: string }> {
    const project = this.deps.db.getProject(projectId);
    if (!project) return { ok: false, message: "project not found" };
    const outcome = await this.deps.git.mergeIntegrationToBase(
      project.localPath,
      project.baseBranch,
      project.integrationBranch,
    );
    if (outcome.status === "conflicted") {
      return {
        ok: false,
        message: `Conflicts merging into ${project.baseBranch}: ${outcome.conflictFiles.join(", ")}`,
      };
    }
    await this.deps.notifier.notify({
      kind: "merged",
      projectId,
      title: `Promoted to ${project.baseBranch}`,
      body: `${project.integrationBranch} → ${project.baseBranch} (${outcome.mergeCommit?.slice(0, 8)}). Push is left to you.`,
      at: Date.now(),
    });
    return {
      ok: true,
      message: `Merged ${project.integrationBranch} into ${project.baseBranch} locally (${outcome.mergeCommit?.slice(0, 8)}). Review and push when ready.`,
    };
  }

  async integrationLog(projectId: string, limit = 30): Promise<CommitLogEntry[]> {
    const project = this.deps.db.getProject(projectId);
    if (!project) return [];
    try {
      return await this.deps.git.recentLog(project.localPath, project.integrationBranch, limit);
    } catch {
      return [];
    }
  }

  private emitProject(projectId: string): void {
    this.deps.bus.emit({ type: "project_changed", projectId, at: Date.now() });
  }
}
