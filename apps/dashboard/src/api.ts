// Thin typed fetch helpers + a reconnecting WebSocket hook.
import { useEffect, useRef, useState } from "react";

export interface Project {
  id: string;
  repoUrl: string;
  integrationBranch: string;
  baseBranch: string;
  specPath: string | null;
  expectations: string;
  groundRules: string[];
  status: string;
  runState: "running" | "paused" | "stopped";
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

export interface Merge {
  id: string;
  status: string;
  mergeCommit: string | null;
  conflictFiles: string[];
  createdAt: number;
}

export interface ChangelogEntry {
  id: string;
  entry: string;
  agentRole: string | null;
  createdAt: number;
}

export interface TicketEvent {
  id: string;
  projectId: string;
  ticketId: string;
  actor: string;
  kind: "triage" | "work" | "merge" | "close" | "note";
  message: string;
  createdAt: number;
}

export interface CommitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
  timestamp: number;
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
  merges: Merge[];
  changelog: ChangelogEntry[];
  suggestions: Suggestion[];
}

export interface Role {
  id: string;
  name: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  backendId: string;
  model?: string;
}

export interface RoleInput {
  name: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  backendId: string;
  model?: string;
}

export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  backendId: string;
  model?: string;
  createdAt: number;
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

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  state: () => fetch("/api/state").then((r) => json<AppState>(r)),
  backends: () => fetch("/api/backends").then((r) => json<BackendInfo[]>(r)),
  refreshBackends: () =>
    fetch("/api/backends/refresh", { method: "POST" }).then((r) => json<BackendInfo[]>(r)),
  projects: () => fetch("/api/projects").then((r) => json<Project[]>(r)),
  project: (id: string) => fetch(`/api/projects/${id}`).then((r) => json<ProjectDetail>(r)),
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
    patch: { baseBranch?: string; expectations?: string; groundRules?: string[] },
  ) =>
    fetch(`/api/projects/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).then((r) => json<Project>(r)),
  addTicket: (id: string, t: { title: string; body: string; roleName?: string; priority?: number }) =>
    fetch(`/api/projects/${id}/tickets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(t),
    }).then((r) => json(r)),
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
  reorderTickets: (id: string, orderedIds: string[]) =>
    fetch(`/api/projects/${id}/tickets/reorder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderedIds }),
    }).then((r) => json(r)),
  integrationLog: (id: string, limit?: number) =>
    fetch(`/api/projects/${id}/integration-log${limit ? `?limit=${limit}` : ""}`).then((r) =>
      json<CommitLogEntry[]>(r),
    ),
  upsertRole: (id: string, role: RoleInput) =>
    fetch(`/api/projects/${id}/roles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(role),
    }).then((r) => json<Role>(r)),
  deleteRole: (id: string, name: string) =>
    fetch(`/api/projects/${id}/roles/${encodeURIComponent(name)}`, { method: "DELETE" }).then((r) =>
      json(r),
    ),
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
  approve: (id: string) =>
    fetch(`/api/projects/${id}/approve`, { method: "POST" }).then((r) =>
      json<{ ok: boolean; message: string }>(r),
    ),
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
