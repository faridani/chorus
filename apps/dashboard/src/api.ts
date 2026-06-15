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

export interface ProjectDetail {
  project: Project;
  tickets: Ticket[];
  roles: Role[];
  merges: Merge[];
  changelog: ChangelogEntry[];
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

export interface AppState {
  orchestrator: string;
  runningTasks: string[];
  quota: { state: string; resumeAt: number | null };
  usageTotals: { inputTokens: number; outputTokens: number };
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  state: () => fetch("/api/state").then((r) => json<AppState>(r)),
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
