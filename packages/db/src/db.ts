import Database from "better-sqlite3";
import type {
  AgentRun,
  AgentTemplate,
  ChangelogEntry,
  Merge,
  Project,
  QuotaInfo,
  Role,
  Task,
  TaskState,
  Ticket,
  UsageEvent,
} from "@chorus/core";
import { runMigrations } from "./migrations.js";

type Row = Record<string, unknown>;

/**
 * The single source of truth. The daemon is the only writer; the web layer
 * reads through this same instance in-process. WAL + busy_timeout keep the
 * occasional concurrent read from blocking.
 */
export class ChorusDb {
  readonly raw: Database.Database;

  constructor(path: string) {
    this.raw = new Database(path);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("busy_timeout = 5000");
    this.raw.pragma("foreign_keys = ON");
    runMigrations(this.raw);
  }

  close(): void {
    this.raw.close();
  }

  // ---- projects ----
  insertProject(p: Project): void {
    this.raw
      .prepare(
        `INSERT INTO projects (id, repo_url, local_path, integration_branch, base_branch, spec_path, expectations, ground_rules, status, run_state, created_at)
         VALUES (@id, @repoUrl, @localPath, @integrationBranch, @baseBranch, @specPath, @expectations, @groundRules, @status, @runState, @createdAt)`,
      )
      .run({ ...p, groundRules: JSON.stringify(p.groundRules) });
  }
  updateProject(id: string, patch: Partial<Project>): void {
    const cur = this.getProject(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.raw
      .prepare(
        `UPDATE projects SET repo_url=@repoUrl, local_path=@localPath, integration_branch=@integrationBranch,
         base_branch=@baseBranch, spec_path=@specPath, expectations=@expectations, ground_rules=@groundRules, status=@status, run_state=@runState WHERE id=@id`,
      )
      .run({ ...next, groundRules: JSON.stringify(next.groundRules) });
  }
  getProject(id: string): Project | undefined {
    const r = this.raw.prepare("SELECT * FROM projects WHERE id=?").get(id) as Row | undefined;
    return r ? mapProject(r) : undefined;
  }
  listProjects(): Project[] {
    return (this.raw.prepare("SELECT * FROM projects ORDER BY created_at DESC").all() as Row[]).map(
      mapProject,
    );
  }

  // ---- roles ----
  insertRole(r: Role): void {
    this.raw
      .prepare(
        `INSERT INTO roles (id, project_id, name, description, allowed, forbidden, backend_id, model)
         VALUES (@id, @projectId, @name, @description, @allowed, @forbidden, @backendId, @model)`,
      )
      .run({ ...r, allowed: JSON.stringify(r.allowed), forbidden: JSON.stringify(r.forbidden), model: r.model ?? null });
  }
  listRoles(projectId: string): Role[] {
    return (
      this.raw.prepare("SELECT * FROM roles WHERE project_id=? ORDER BY name").all(projectId) as Row[]
    ).map(mapRole);
  }
  getRole(projectId: string, name: string): Role | undefined {
    const r = this.raw
      .prepare("SELECT * FROM roles WHERE project_id=? AND name=?")
      .get(projectId, name) as Row | undefined;
    return r ? mapRole(r) : undefined;
  }
  updateRole(r: Role): void {
    this.raw
      .prepare(
        `UPDATE roles SET description=@description, allowed=@allowed, forbidden=@forbidden,
         backend_id=@backendId, model=@model WHERE id=@id`,
      )
      .run({
        ...r,
        allowed: JSON.stringify(r.allowed),
        forbidden: JSON.stringify(r.forbidden),
        model: r.model ?? null,
      });
  }
  deleteRole(projectId: string, name: string): void {
    this.raw.prepare("DELETE FROM roles WHERE project_id=? AND name=?").run(projectId, name);
  }

  // ---- agent templates (global gallery) ----
  insertAgentTemplate(t: AgentTemplate): void {
    this.raw
      .prepare(
        `INSERT INTO agent_templates (id, name, description, allowed, forbidden, backend_id, model, created_at)
         VALUES (@id, @name, @description, @allowed, @forbidden, @backendId, @model, @createdAt)`,
      )
      .run({
        ...t,
        allowed: JSON.stringify(t.allowed),
        forbidden: JSON.stringify(t.forbidden),
        model: t.model ?? null,
      });
  }
  updateAgentTemplate(t: AgentTemplate): void {
    this.raw
      .prepare(
        `UPDATE agent_templates SET description=@description, allowed=@allowed, forbidden=@forbidden,
         backend_id=@backendId, model=@model WHERE id=@id`,
      )
      .run({
        ...t,
        allowed: JSON.stringify(t.allowed),
        forbidden: JSON.stringify(t.forbidden),
        model: t.model ?? null,
      });
  }
  deleteAgentTemplate(name: string): void {
    this.raw.prepare("DELETE FROM agent_templates WHERE name=?").run(name);
  }
  getAgentTemplate(name: string): AgentTemplate | undefined {
    const r = this.raw.prepare("SELECT * FROM agent_templates WHERE name=?").get(name) as
      | Row
      | undefined;
    return r ? mapAgentTemplate(r) : undefined;
  }
  listAgentTemplates(): AgentTemplate[] {
    return (
      this.raw.prepare("SELECT * FROM agent_templates ORDER BY name").all() as Row[]
    ).map(mapAgentTemplate);
  }

  // ---- tickets ----
  insertTicket(t: Ticket): void {
    this.raw
      .prepare(
        `INSERT INTO tickets (id, project_id, title, body, status, role_name, priority, source, created_at, updated_at)
         VALUES (@id, @projectId, @title, @body, @status, @roleName, @priority, @source, @createdAt, @updatedAt)`,
      )
      .run({ ...t, roleName: t.roleName ?? null });
  }
  updateTicket(id: string, patch: Partial<Ticket>): void {
    const cur = this.getTicket(id);
    if (!cur) return;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.raw
      .prepare(
        `UPDATE tickets SET title=@title, body=@body, status=@status, role_name=@roleName,
         priority=@priority, updated_at=@updatedAt WHERE id=@id`,
      )
      .run({ ...next, roleName: next.roleName ?? null });
  }
  getTicket(id: string): Ticket | undefined {
    const r = this.raw.prepare("SELECT * FROM tickets WHERE id=?").get(id) as Row | undefined;
    return r ? mapTicket(r) : undefined;
  }
  deleteTicket(id: string): void {
    // Tasks (and their merges) cascade via FK; changelog entries are kept as
    // historical record (changelog.ticket_id has no FK).
    this.raw.prepare("DELETE FROM tickets WHERE id=?").run(id);
  }
  listTickets(projectId: string): Ticket[] {
    return (
      this.raw
        .prepare("SELECT * FROM tickets WHERE project_id=? ORDER BY priority DESC, created_at")
        .all(projectId) as Row[]
    ).map(mapTicket);
  }
  /** Open tickets eligible for dispatch, highest priority first. */
  nextOpenTicket(projectId: string): Ticket | undefined {
    const r = this.raw
      .prepare(
        "SELECT * FROM tickets WHERE project_id=? AND status='open' ORDER BY priority DESC, created_at LIMIT 1",
      )
      .get(projectId) as Row | undefined;
    return r ? mapTicket(r) : undefined;
  }

  // ---- tasks ----
  insertTask(t: Task): void {
    this.raw
      .prepare(
        `INSERT INTO tasks (id, ticket_id, project_id, backend_id, worktree_path, branch, base_commit, state, attempt, resume_at, started_at, ended_at)
         VALUES (@id, @ticketId, @projectId, @backendId, @worktreePath, @branch, @baseCommit, @state, @attempt, @resumeAt, @startedAt, @endedAt)`,
      )
      .run(t);
  }
  updateTask(id: string, patch: Partial<Task>): void {
    const cur = this.getTask(id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    this.raw
      .prepare(
        `UPDATE tasks SET state=@state, attempt=@attempt, resume_at=@resumeAt, started_at=@startedAt, ended_at=@endedAt WHERE id=@id`,
      )
      .run(next);
  }
  getTask(id: string): Task | undefined {
    const r = this.raw.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Row | undefined;
    return r ? mapTask(r) : undefined;
  }
  listTasksByState(state: TaskState): Task[] {
    return (this.raw.prepare("SELECT * FROM tasks WHERE state=?").all(state) as Row[]).map(mapTask);
  }
  listTasksByStates(states: TaskState[]): Task[] {
    if (states.length === 0) return [];
    const placeholders = states.map(() => "?").join(",");
    return (
      this.raw.prepare(`SELECT * FROM tasks WHERE state IN (${placeholders})`).all(...states) as Row[]
    ).map(mapTask);
  }
  listTasksForTicket(ticketId: string): Task[] {
    return (
      this.raw.prepare("SELECT * FROM tasks WHERE ticket_id=? ORDER BY attempt").all(ticketId) as Row[]
    ).map(mapTask);
  }

  // ---- agent_runs ----
  insertRun(r: AgentRun): void {
    this.raw
      .prepare(
        `INSERT INTO agent_runs (id, task_id, pid, pgid, started_at, ended_at, exit_code, exit_signal, terminal_reason, raw_log_path, output_file_path)
         VALUES (@id, @taskId, @pid, @pgid, @startedAt, @endedAt, @exitCode, @exitSignal, @terminalReason, @rawLogPath, @outputFilePath)`,
      )
      .run(r);
  }
  updateRun(id: string, patch: Partial<AgentRun>): void {
    const cur = this.raw.prepare("SELECT * FROM agent_runs WHERE id=?").get(id) as Row | undefined;
    if (!cur) return;
    const next = { ...mapRun(cur), ...patch };
    this.raw
      .prepare(
        `UPDATE agent_runs SET pid=@pid, pgid=@pgid, ended_at=@endedAt, exit_code=@exitCode,
         exit_signal=@exitSignal, terminal_reason=@terminalReason, raw_log_path=@rawLogPath, output_file_path=@outputFilePath WHERE id=@id`,
      )
      .run(next);
  }
  /** Runs that never recorded an end — interrupted by a daemon restart. */
  listUnfinishedRuns(): AgentRun[] {
    return (this.raw.prepare("SELECT * FROM agent_runs WHERE ended_at IS NULL").all() as Row[]).map(
      mapRun,
    );
  }

  // ---- merges ----
  insertMerge(m: Merge): void {
    this.raw
      .prepare(
        `INSERT INTO merges (id, task_id, project_id, integration_branch, merge_commit, status, conflict_files, created_at)
         VALUES (@id, @taskId, @projectId, @integrationBranch, @mergeCommit, @status, @conflictFiles, @createdAt)`,
      )
      .run({ ...m, conflictFiles: JSON.stringify(m.conflictFiles) });
  }
  listMerges(projectId: string, limit = 50): Merge[] {
    return (
      this.raw
        .prepare("SELECT * FROM merges WHERE project_id=? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit) as Row[]
    ).map(mapMerge);
  }

  // ---- changelog ----
  insertChangelog(c: ChangelogEntry): void {
    this.raw
      .prepare(
        `INSERT INTO changelog (id, project_id, ticket_id, merge_id, entry, agent_role, created_at)
         VALUES (@id, @projectId, @ticketId, @mergeId, @entry, @agentRole, @createdAt)`,
      )
      .run({ ...c, ticketId: c.ticketId ?? null, mergeId: c.mergeId ?? null, agentRole: c.agentRole ?? null });
  }
  listChangelog(projectId: string, limit = 100): ChangelogEntry[] {
    return (
      this.raw
        .prepare("SELECT * FROM changelog WHERE project_id=? ORDER BY created_at DESC LIMIT ?")
        .all(projectId, limit) as Row[]
    ).map(mapChangelog);
  }

  // ---- usage ----
  insertUsage(u: UsageEvent): void {
    this.raw
      .prepare(
        `INSERT INTO usage_events (id, run_id, project_id, kind, input_tokens, output_tokens, detail, observed_at)
         VALUES (@id, @runId, @projectId, @kind, @inputTokens, @outputTokens, @detail, @observedAt)`,
      )
      .run({
        ...u,
        runId: u.runId ?? null,
        projectId: u.projectId ?? null,
        inputTokens: u.inputTokens ?? null,
        outputTokens: u.outputTokens ?? null,
        detail: u.detail ?? null,
      });
  }
  recentUsage(limit = 200): UsageEvent[] {
    return (
      this.raw.prepare("SELECT * FROM usage_events ORDER BY observed_at DESC LIMIT ?").all(limit) as Row[]
    ).map(mapUsage);
  }
  usageTotals(): { inputTokens: number; outputTokens: number } {
    const r = this.raw
      .prepare(
        "SELECT COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o FROM usage_events",
      )
      .get() as { i: number; o: number };
    return { inputTokens: r.i, outputTokens: r.o };
  }

  // ---- quota singleton ----
  getQuota(): QuotaInfo {
    const r = this.raw.prepare("SELECT * FROM quota_state WHERE id=1").get() as Row | undefined;
    if (!r) {
      const info: QuotaInfo = {
        state: "available",
        resumeAt: null,
        consecutivePauses: 0,
        updatedAt: Date.now(),
      };
      this.raw
        .prepare(
          "INSERT INTO quota_state (id, state, resume_at, consecutive_pauses, updated_at) VALUES (1, @state, @resumeAt, @consecutivePauses, @updatedAt)",
        )
        .run(info);
      return info;
    }
    return {
      state: r.state as QuotaInfo["state"],
      resumeAt: (r.resume_at as number | null) ?? null,
      consecutivePauses: r.consecutive_pauses as number,
      updatedAt: r.updated_at as number,
    };
  }
  setQuota(info: QuotaInfo): void {
    this.getQuota(); // ensure row exists
    this.raw
      .prepare(
        "UPDATE quota_state SET state=@state, resume_at=@resumeAt, consecutive_pauses=@consecutivePauses, updated_at=@updatedAt WHERE id=1",
      )
      .run({ ...info, updatedAt: Date.now() });
  }
}

// ---- row mappers ----
function mapProject(r: Row): Project {
  return {
    id: r.id as string,
    repoUrl: r.repo_url as string,
    localPath: r.local_path as string,
    integrationBranch: r.integration_branch as string,
    baseBranch: r.base_branch as string,
    specPath: (r.spec_path as string | null) ?? null,
    expectations: (r.expectations as string | null) ?? "",
    groundRules: JSON.parse((r.ground_rules as string | null) ?? "[]"),
    status: r.status as Project["status"],
    runState: (r.run_state as Project["runState"] | null) ?? "running",
    createdAt: r.created_at as number,
  };
}
function mapRole(r: Row): Role {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    description: r.description as string,
    allowed: JSON.parse(r.allowed as string),
    forbidden: JSON.parse(r.forbidden as string),
    backendId: r.backend_id as string,
    model: (r.model as string | null) ?? undefined,
  };
}
function mapAgentTemplate(r: Row): AgentTemplate {
  return {
    id: r.id as string,
    name: r.name as string,
    description: r.description as string,
    allowed: JSON.parse(r.allowed as string),
    forbidden: JSON.parse(r.forbidden as string),
    backendId: r.backend_id as string,
    model: (r.model as string | null) ?? undefined,
    createdAt: r.created_at as number,
  };
}
function mapTicket(r: Row): Ticket {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    body: r.body as string,
    status: r.status as Ticket["status"],
    roleName: (r.role_name as string | null) ?? null,
    priority: r.priority as number,
    source: r.source as Ticket["source"],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
  };
}
function mapTask(r: Row): Task {
  return {
    id: r.id as string,
    ticketId: r.ticket_id as string,
    projectId: r.project_id as string,
    backendId: r.backend_id as string,
    worktreePath: r.worktree_path as string,
    branch: r.branch as string,
    baseCommit: r.base_commit as string,
    state: r.state as Task["state"],
    attempt: r.attempt as number,
    resumeAt: (r.resume_at as number | null) ?? null,
    startedAt: (r.started_at as number | null) ?? null,
    endedAt: (r.ended_at as number | null) ?? null,
  };
}
function mapRun(r: Row): AgentRun {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    pid: (r.pid as number | null) ?? null,
    pgid: (r.pgid as number | null) ?? null,
    startedAt: r.started_at as number,
    endedAt: (r.ended_at as number | null) ?? null,
    exitCode: (r.exit_code as number | null) ?? null,
    exitSignal: (r.exit_signal as string | null) ?? null,
    terminalReason: (r.terminal_reason as AgentRun["terminalReason"]) ?? null,
    rawLogPath: (r.raw_log_path as string | null) ?? null,
    outputFilePath: (r.output_file_path as string | null) ?? null,
  };
}
function mapMerge(r: Row): Merge {
  return {
    id: r.id as string,
    taskId: r.task_id as string,
    projectId: r.project_id as string,
    integrationBranch: r.integration_branch as string,
    mergeCommit: (r.merge_commit as string | null) ?? null,
    status: r.status as Merge["status"],
    conflictFiles: JSON.parse(r.conflict_files as string),
    createdAt: r.created_at as number,
  };
}
function mapChangelog(r: Row): ChangelogEntry {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    ticketId: (r.ticket_id as string | null) ?? null,
    mergeId: (r.merge_id as string | null) ?? null,
    entry: r.entry as string,
    agentRole: (r.agent_role as string | null) ?? null,
    createdAt: r.created_at as number,
  };
}
function mapUsage(r: Row): UsageEvent {
  return {
    id: r.id as string,
    runId: (r.run_id as string | null) ?? null,
    projectId: (r.project_id as string | null) ?? null,
    kind: r.kind as UsageEvent["kind"],
    inputTokens: (r.input_tokens as number | null) ?? null,
    outputTokens: (r.output_tokens as number | null) ?? null,
    detail: (r.detail as string | null) ?? null,
    observedAt: r.observed_at as number,
  };
}
