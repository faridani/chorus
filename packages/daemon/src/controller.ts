import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BackendRegistry } from "@chorus/backends";
import {
  type ChorusBus,
  type Config,
  type ControlApi,
  type CreateProjectInput,
  type CreateTicketInput,
  newId,
  type Project,
  type Role,
  type Ticket,
  type UpsertRoleInput,
} from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import type { GitService } from "@chorus/git-service";
import type { Notifier } from "@chorus/core";
import type { Orchestrator } from "@chorus/orchestrator";
import { findSpec, SpecIngestor } from "@chorus/spec-ingest";

export interface ControllerDeps {
  db: ChorusDb;
  git: GitService;
  backends: BackendRegistry;
  orchestrator: Orchestrator;
  notifier: Notifier;
  bus: ChorusBus;
  config: Config;
}

const DEFAULT_ROLES: UpsertRoleInput[] = [
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

  constructor(private readonly deps: ControllerDeps) {
    this.ingestor = new SpecIngestor(deps.db);
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const id = newId("proj");
    const localPath = join(this.deps.config.dataDir, "repos", id);
    const project: Project = {
      id,
      repoUrl: input.repoUrl,
      localPath,
      integrationBranch: this.deps.config.integrationBranch,
      baseBranch: "main",
      specPath: null,
      status: "initializing",
      createdAt: Date.now(),
    };
    this.deps.db.insertProject(project);
    this.emitProject(id);
    // Initialize in the background so the UI returns immediately.
    void this.initProject(project, input.specText);
    return project;
  }

  private async initProject(project: Project, specText?: string): Promise<void> {
    try {
      await this.deps.git.clone(project.repoUrl, project.localPath);
      const baseBranch = await this.deps.git.detectDefaultBranch(project.localPath);
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

  addTicket(projectId: string, input: CreateTicketInput): Promise<Ticket> {
    const now = Date.now();
    const ticket: Ticket = {
      id: newId("tkt"),
      projectId,
      title: input.title,
      body: input.body,
      status: "open",
      roleName: input.roleName ?? "software-dev",
      priority: input.priority ?? 0,
      source: "manual",
      createdAt: now,
      updatedAt: now,
    };
    this.deps.db.insertTicket(ticket);
    this.deps.bus.emit({ type: "ticket_changed", projectId, ticketId: ticket.id, at: now });
    void this.deps.orchestrator.tick();
    return Promise.resolve(ticket);
  }

  upsertRole(projectId: string, input: UpsertRoleInput): Promise<Role> {
    const existing = this.deps.db.getRole(projectId, input.name);
    if (existing) {
      // Roles are immutable-by-id in M1; replace by re-seeding is out of scope.
      return Promise.resolve(existing);
    }
    return Promise.resolve(this.seedRole(projectId, input));
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

  private emitProject(projectId: string): void {
    this.deps.bus.emit({ type: "project_changed", projectId, at: Date.now() });
  }
}
