// Thin typed fetch helpers + a reconnecting WebSocket hook.
import { useEffect, useRef, useState } from "react";

export interface Project {
  id: string;
  repoUrl: string;
  baseBranch: string;
  specPath: string | null;
  expectations: string;
  groundRules: string[];
  setupCommand: string | null;
  verifyCommands: string[];
  status: string;
  runState: "running" | "paused" | "stopped";
  idleIdeation: boolean;
  idleIdeationCount: number;
  createdAt: number;
}

export interface Ticket {
  id: string;
  title: string;
  body: string;
  status: string;
  roleName: string | null;
  priority: number;
  source: string;
  branch: string | null;
  worktreePath: string | null;
  prUrl: string | null;
  prNumber: number | null;
  starred: boolean;
  tasks: Task[];
}

export interface Task {
  id: string;
  state: string;
  branch: string;
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface PullRequest {
  id: string;
  ticketId: string;
  url: string;
  number: number | null;
  state: string;
  createdAt: number;
  updatedAt: number;
}

export interface TicketCleanupResult {
  deletedTickets: number;
  closedPullRequests: number;
  removedBranches: number;
}

export interface ChangelogEntry {
  id: string;
  entry: string;
  agentRole: string | null;
  createdAt: number;
}

export interface DiagnosisResult {
  status: "working_as_expected" | "needs_ticket" | "uncertain";
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedAction: string;
  ticket: { title: string; body: string; priority: number; roleName: string };
  confidence: number;
}

export interface SelfHealProposal {
  id: string;
  kind: "role" | "expectations" | "ground_rules";
  title: string;
  rationale: string;
  roleName?: string;
  description?: string;
  allowed?: string[];
  forbidden?: string[];
  allowedToolIds?: string[];
  forbiddenToolIds?: string[];
  model?: string;
  expectations?: string;
  groundRules?: string[];
}

export interface SelfHealResult {
  summary: string;
  proposals: SelfHealProposal[];
}

export interface AttemptJournalEntry {
  id: string;
  taskId: string;
  ticketId: string;
  attempt: number;
  verifyPassed: boolean | null;
  verifyOutput: string | null;
  diagnosis: string | null;
  nextAction: string | null;
  evaluatorVerdict: string | null;
  reviewerVerdict: string | null;
  proof: string | null;
  createdAt: number;
}

export interface TicketEvent {
  id: string;
  projectId: string;
  ticketId: string;
  actor: string;
  kind: "triage" | "work" | "pr" | "close" | "note";
  message: string;
  createdAt: number;
}

export interface Suggestion {
  id: string;
  projectId: string;
  ticketId: string | null;
  message: string;
  status: string;
  createdAt: number;
}

export interface ProjectDetail {
  project: Project;
  tickets: Ticket[];
  roles: Role[];
  pullRequests: PullRequest[];
  attemptJournal: AttemptJournalEntry[];
  changelog: ChangelogEntry[];
  suggestions: Suggestion[];
}

export interface Role {
  id: string;
  name: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  allowedToolIds: string[];
  forbiddenToolIds: string[];
  backendId: string;
  model?: string;
}

export interface RoleInput {
  name: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  allowedToolIds: string[];
  forbiddenToolIds: string[];
  backendId: string;
  model?: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  displayName: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  allowedToolIds: string[];
  forbiddenToolIds: string[];
  backendId: string;
  model?: string;
  category: string;
  version?: string;
  source: "builtin" | "custom";
  readOnly: boolean;
  createdAt?: number;
}

export interface ToolDef {
  id: string;
  name: string;
  category: string;
  description: string;
  risk: "low" | "medium" | "high";
  sideEffects: boolean;
  availability: "available" | "planned";
  usageNote: string;
}

export interface VersionInfo {
  number: string;
  commit: string;
  dirty: boolean;
  startedAt: number;
}

export interface BackendInfo {
  id: string;
  label: string;
  bin: string;
  available: boolean;
  version: string | null;
  models: string[];
  defaultModel: string | null;
  implemented: boolean;
}

export interface AppState {
  orchestrator: string;
  runningTasks: string[];
  quota: { state: string; resumeAt: number | null };
  usageTotals: { inputTokens: number; outputTokens: number };
  version?: VersionInfo;
}

export interface GlobalSettings {
  dataDir: string;
  worktreesDir: string;
  reposDir: string;
  host: string;
  port: number;
  maxConcurrentAgents: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  state: () => fetch("/api/state").then((r) => json<AppState>(r)),
  settings: () => fetch("/api/settings").then((r) => json<GlobalSettings>(r)),
  backends: () => fetch("/api/backends").then((r) => json<BackendInfo[]>(r)),
  refreshBackends: () =>
    fetch("/api/backends/refresh", { method: "POST" }).then((r) => json<BackendInfo[]>(r)),
  projects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<ProjectDetail>(r)),
  projectSpec: (id: string) =>
    fetch(`/api/projects/${id}/spec`).then((r) => json<{ path: string | null; content: string | null }>(r)),
  createProject: (repoUrl: string, specText?: string, baseBranch?: string) =>
    fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repoUrl, specText, baseBranch }),
    }).then((r) => json<Project>(r)),
  provideSpec: (id: string, specText: string) =>
    fetch(`/api/projects/${id}/spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ specText }),
    }).then((r) => json(r)),
  updateProject: (
    id: string,
    patch: {
      baseBranch?: string;
      expectations?: string;
      groundRules?: string[];
      setupCommand?: string;
      verifyCommands?: string[];
      idleIdeation?: boolean;
      idleIdeationCount?: number;
    },
  ) =>
    fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Project>(r)),
  addTicket: (
    id: string,
    t: { title: string; body: string; roleName?: string; priority?: number; fromDiagnostic?: boolean },
  ) =>
    fetch(`/api/projects/${id}/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t),
    }).then((r) => json(r)),
  debugTraces: (id: string, liveEvents: unknown[]) =>
    fetch(`/api/projects/${id}/debug-traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ liveEvents }),
    }).then((r) => json<DiagnosisResult>(r)),
  debugTracesTicket: (id: string, ticketId: string, liveEvents: unknown[]) =>
    fetch(`/api/projects/${id}/tickets/${ticketId}/debug-traces`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ liveEvents }),
    }).then((r) => json<DiagnosisResult>(r)),
  updateTicket: (
    id: string,
    ticketId: string,
    patch: { title?: string; body?: string; roleName?: string; priority?: number; reopen?: boolean },
  ) =>
    fetch(`/api/projects/${id}/tickets/${ticketId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json(r)),
  deleteTicket: (id: string, ticketId: string) =>
    fetch(`/api/projects/${id}/tickets/${ticketId}`, { method: "DELETE" }).then((r) => json(r)),
  cleanupTickets: (
    id: string,
    options: { confirmation: string; removeBranches: boolean; removePullRequests: boolean },
  ) =>
    fetch(`/api/projects/${id}/tickets/cleanup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(options),
    }).then((r) => json<TicketCleanupResult>(r)),
  reorderTickets: (id: string, orderedIds: string[]) =>
    fetch(`/api/projects/${id}/tickets/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    }).then((r) => json(r)),
  setTicketStarred: (id: string, ticketId: string, starred: boolean) =>
    fetch(`/api/projects/${id}/tickets/${ticketId}/star`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ starred }),
    }).then((r) => json<Ticket>(r)),
  addressPrComments: (id: string, ticketId: string) =>
    fetch(`/api/projects/${id}/tickets/${ticketId}/address-pr-comments`, { method: "POST" }).then(
      (r) => json<{ started: boolean }>(r),
    ),
  selfHeal: (id: string, ticketId: string, liveEvents: unknown[]) =>
    fetch(`/api/projects/${id}/tickets/${ticketId}/self-heal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ liveEvents }),
    }).then((r) => json<SelfHealResult>(r)),
  applySelfHealProposal: (id: string, proposal: SelfHealProposal) =>
    fetch(`/api/projects/${id}/self-heal/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposal }),
    }).then((r) => json(r)),
  upsertRole: (id: string, role: RoleInput) =>
    fetch(`/api/projects/${id}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(role),
    }).then((r) => json<Role>(r)),
  applyTemplate: (id: string, template: AgentTemplate | string) => {
    const body =
      typeof template === "string"
        ? { name: template }
        : { id: template.id, name: template.name, source: template.source };
    return fetch(`/api/projects/${id}/roles/from-template`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => json<Role>(r));
  },
  deleteRole: (id: string, name: string) =>
    fetch(`/api/projects/${id}/roles/${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) =>
      json(r),
    ),
  tools: () => fetch("/api/tools").then((r) => json<ToolDef[]>(r)),
  projectEvents: (id: string) =>
    fetch(`/api/projects/${id}/events`).then((r) => json<TicketEvent[]>(r)),
  dismissSuggestion: (id: string, sid: string) =>
    fetch(`/api/projects/${id}/suggestions/${sid}/dismiss`, { method: "POST" }).then((r) => json(r)),
  agentTemplates: () => fetch("/api/agent-templates").then((r) => json<AgentTemplate[]>(r)),
  upsertAgentTemplate: (t: RoleInput) =>
    fetch("/api/agent-templates", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t),
    }).then((r) => json<AgentTemplate>(r)),
  deleteAgentTemplate: (name: string) =>
    fetch(`/api/agent-templates/${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) =>
      json(r),
    ),
  setProjectRunState: (id: string, state: "running" | "paused" | "stopped") =>
    fetch(`/api/projects/${id}/run-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state }),
    }).then((r) => json<Project>(r)),
  orchestrator: (action: "start" | "pause" | "stop") =>
    fetch(`/api/orchestrator/${action}`, { method: "POST" }).then((r) => json(r)),
};

/** Subscribe to the live event feed; returns the latest event + a tick counter. */
export function useEvents(onEvent: (e: any) => void): void {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onmessage = (ev) => {
        try {
          ref.current(JSON.parse(ev.data));
        } catch {
          /* ignore */
        }
      };
      ws.onclose = () => {
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
