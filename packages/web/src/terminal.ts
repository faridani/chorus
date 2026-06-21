import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { BackendInfo, Config, Project, Ticket } from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import { GitService, type GitWorktreeInfo } from "@chorus/git-service";
import { StreamingProcess, type StreamExit } from "@chorus/proc";

export interface TerminalWorktree {
  id: string;
  label: string;
  branch: string;
  kind: "base" | "ticket" | "scratch" | "worktree";
  ticketId?: string;
  ticketTitle?: string;
}

interface TerminalWorktreeEntry extends TerminalWorktree {
  path: string;
}

export interface TerminalSessionInfo {
  sessionToken: string;
  projectId: string;
  worktreeId: string;
  backendId: string | null;
  mode: "shell" | "backend";
}

interface TerminalSession extends TerminalSessionInfo {
  token: string;
  worktreePath: string;
  startedAt: number;
  proc?: StreamingProcess;
  socket?: TerminalSocket;
  attachTimer?: NodeJS.Timeout;
  stopping: boolean;
}

interface TerminalSocket {
  send(data: string): void;
  close(): void;
  on(event: "message", handler: (data: unknown) => void): void;
  on(event: "close", handler: () => void): void;
}

export class TerminalError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export class TerminalSessionManager {
  private readonly git: GitService;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    private readonly deps: {
      db: ChorusDb;
      config: Config;
      listBackends: () => BackendInfo[];
      git?: GitService;
    },
  ) {
    this.git = deps.git ?? new GitService();
  }

  async listWorktrees(projectId: string): Promise<TerminalWorktree[]> {
    const project = this.requireProject(projectId);
    return (await this.listWorktreeEntries(project)).map(({ path: _path, ...wt }) => wt);
  }

  async createScratchWorktree(projectId: string): Promise<TerminalWorktree> {
    const project = this.requireProject(projectId);
    const id = `ai_${randomUUID().slice(0, 8)}`;
    const branch = `chorus/ai-a-la-carte/${id}`;
    const worktreePath = join(this.projectWorktreesRoot(project.id), "ai-a-la-carte", id);
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.git.addWorktree(project.localPath, worktreePath, branch, project.baseBranch);
    const entry = (await this.listWorktreeEntries(project)).find((wt) => normalizePath(wt.path) === normalizePath(worktreePath));
    if (!entry) throw new TerminalError(500, "created worktree was not registered by git");
    const { path: _path, ...publicEntry } = entry;
    return publicEntry;
  }

  async createSession(input: {
    projectId: string;
    worktreeId: string;
    backendId?: string | null;
  }): Promise<TerminalSessionInfo> {
    const project = this.requireProject(input.projectId);
    const worktree = (await this.listWorktreeEntries(project)).find((wt) => wt.id === input.worktreeId);
    if (!worktree) throw new TerminalError(400, "unknown worktree");
    if (!this.pathAllowedForProject(project, worktree.path)) {
      throw new TerminalError(400, "worktree is outside this project");
    }
    if (!existsSync(worktree.path)) throw new TerminalError(400, "worktree path does not exist");

    const backendId = input.backendId?.trim() || null;
    if (backendId) this.requireAvailableBackend(backendId);

    const token = randomUUID();
    const session: TerminalSession = {
      sessionToken: token,
      token,
      projectId: project.id,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      backendId,
      mode: backendId ? "backend" : "shell",
      startedAt: Date.now(),
      stopping: false,
    };
    session.attachTimer = setTimeout(() => void this.stopSession(project.id, token), 30_000);
    session.attachTimer.unref?.();
    this.sessions.set(token, session);
    return {
      sessionToken: token,
      projectId: session.projectId,
      worktreeId: session.worktreeId,
      backendId: session.backendId,
      mode: session.mode,
    };
  }

  attachSocket(token: string, socket: TerminalSocket): boolean {
    const session = this.sessions.get(token);
    if (!session) return false;
    if (session.socket) {
      send(socket, { type: "error", error: "terminal session already attached" });
      socket.close();
      return true;
    }

    if (session.attachTimer) clearTimeout(session.attachTimer);
    session.socket = socket;
    socket.on("message", (data) => this.handleSocketMessage(session, data));
    socket.on("close", () => {
      if (session.socket === socket) session.socket = undefined;
      void this.stopSession(session.projectId, session.token);
    });
    void this.startProcess(session);
    return true;
  }

  async stopSession(projectId: string, token: string): Promise<boolean> {
    const session = this.sessions.get(token);
    if (!session || session.projectId !== projectId) return false;
    if (session.stopping) return true;
    session.stopping = true;
    if (session.attachTimer) clearTimeout(session.attachTimer);
    if (!session.proc) {
      this.sessions.delete(token);
      session.socket?.close();
      return true;
    }
    await session.proc.stop();
    return true;
  }

  private async startProcess(session: TerminalSession): Promise<void> {
    if (session.proc || session.stopping) return;
    try {
      const spec = this.commandForSession(session);
      const proc = new StreamingProcess(spec.cmd, spec.args, {
        cwd: session.worktreePath,
        env: terminalEnv(),
        stdin: "pipe",
        pty: process.platform !== "win32",
        rawLogPath: null,
        killGraceMs: 2_000,
      });
      session.proc = proc;
      send(session.socket, {
        type: "ready",
        mode: session.mode,
        backendId: session.backendId,
        worktreeId: session.worktreeId,
      });
      proc.onData((data) => send(session.socket, { type: "data", data }));
      proc.onStderr((data) => send(session.socket, { type: "data", data }));
      proc.exit.then((exit) => this.finishSession(session, exit)).catch((err) => {
        send(session.socket, { type: "error", error: String(err) });
        this.sessions.delete(session.token);
      });
    } catch (err) {
      send(session.socket, { type: "error", error: (err as Error).message });
      this.sessions.delete(session.token);
      session.socket?.close();
    }
  }

  private finishSession(session: TerminalSession, exit: StreamExit): void {
    send(session.socket, {
      type: "exit",
      code: exit.code,
      signal: exit.signal,
      outcome: exit.outcome,
    });
    this.sessions.delete(session.token);
    session.socket?.close();
  }

  private handleSocketMessage(session: TerminalSession, raw: unknown): void {
    const text = socketText(raw);
    if (!text) return;
    let msg: { type?: unknown; data?: unknown };
    try {
      msg = JSON.parse(text) as { type?: unknown; data?: unknown };
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      session.proc?.writeStdin(msg.data);
    } else if (msg.type === "stop") {
      void this.stopSession(session.projectId, session.token);
    }
  }

  private commandForSession(session: TerminalSession): { cmd: string; args: string[] } {
    if (session.backendId) {
      const backend = this.requireAvailableBackend(session.backendId);
      return { cmd: backend.bin, args: [] };
    }
    const shell = pickShell();
    return { cmd: shell, args: shellArgs(shell) };
  }

  private requireProject(projectId: string): Project {
    const project = this.deps.db.getProject(projectId);
    if (!project) throw new TerminalError(404, "project not found");
    return project;
  }

  private requireAvailableBackend(backendId: string): BackendInfo {
    const backend = this.deps.listBackends().find((b) => b.id === backendId);
    if (!backend || !backend.available) throw new TerminalError(400, "backend is not available");
    return backend;
  }

  private async listWorktreeEntries(project: Project): Promise<TerminalWorktreeEntry[]> {
    const tickets = this.deps.db.listTickets(project.id);
    const ticketByPath = new Map<string, Ticket>();
    for (const ticket of tickets) {
      if (ticket.worktreePath) ticketByPath.set(normalizePath(ticket.worktreePath), ticket);
    }

    let gitWorktrees: GitWorktreeInfo[] = [];
    try {
      gitWorktrees = await this.git.listWorktrees(project.localPath);
    } catch {
      gitWorktrees = [];
    }

    const entries = new Map<string, TerminalWorktreeEntry>();
    const add = (entry: TerminalWorktreeEntry) => {
      if (!this.pathAllowedForProject(project, entry.path)) return;
      entries.set(normalizePath(entry.path), entry);
    };

    add({
      id: "base",
      label: `${project.baseBranch} (base clone)`,
      branch: project.baseBranch,
      kind: "base",
      path: project.localPath,
    });

    for (const wt of gitWorktrees) {
      const path = normalizePath(wt.path);
      if (path === normalizePath(project.localPath)) continue;
      if (!this.pathAllowedForProject(project, path)) continue;
      const ticket = ticketByPath.get(path);
      const branch = wt.branch ?? "(detached)";
      add({
        id: `wt_${hashPath(path)}`,
        label: ticket
          ? `${branch} - ${ticket.title}`
          : `${branch} - ${basename(path)}`,
        branch,
        kind: ticket ? "ticket" : path.includes(`${pathSep()}ai-a-la-carte${pathSep()}`) ? "scratch" : "worktree",
        ticketId: ticket?.id,
        ticketTitle: ticket?.title,
        path,
      });
    }

    for (const ticket of tickets) {
      if (!ticket.worktreePath || !ticket.branch || entries.has(normalizePath(ticket.worktreePath))) continue;
      if (!existsSync(ticket.worktreePath)) continue;
      add({
        id: `wt_${hashPath(ticket.worktreePath)}`,
        label: `${ticket.branch} - ${ticket.title}`,
        branch: ticket.branch,
        kind: "ticket",
        ticketId: ticket.id,
        ticketTitle: ticket.title,
        path: ticket.worktreePath,
      });
    }

    return [...entries.values()];
  }

  private pathAllowedForProject(project: Project, path: string): boolean {
    const resolved = normalizePath(path);
    if (resolved === normalizePath(project.localPath)) return true;
    return isInside(this.projectWorktreesRoot(project.id), resolved);
  }

  private projectWorktreesRoot(projectId: string): string {
    return join(this.deps.config.dataDir, "worktrees", projectId);
  }
}

function terminalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allow = [
    "PATH",
    "HOME",
    "SHELL",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "COLORTERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "SystemRoot",
    "ComSpec",
    "WINDIR",
  ];
  for (const key of allow) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value) env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.CHORUS_TERMINAL = "1";
  return env;
}

function pickShell(): string {
  const configured = process.env.SHELL;
  if (configured && isAbsolute(configured) && existsSync(configured)) return configured;
  for (const candidate of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
    if (existsSync(candidate)) return candidate;
  }
  return process.platform === "win32" ? "cmd.exe" : "sh";
}

function shellArgs(shell: string): string[] {
  const name = basename(shell);
  if (process.platform === "win32") return [];
  if (name === "zsh") return ["-f", "-i"];
  if (name === "bash") return ["--noprofile", "--norc", "-i"];
  return ["-i"];
}

function send(socket: TerminalSocket | undefined, msg: unknown): void {
  if (!socket) return;
  try {
    socket.send(JSON.stringify(msg));
  } catch {
    /* client gone */
  }
}

function socketText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8");
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  return "";
}

function normalizePath(path: string): string {
  return resolve(path);
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

function hashPath(path: string): string {
  return createHash("sha256").update(normalizePath(path)).digest("hex").slice(0, 16);
}

function pathSep(): string {
  return process.platform === "win32" ? "\\" : "/";
}
