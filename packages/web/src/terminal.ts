import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
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

interface ProjectPathScope {
  basePath: string;
  worktreesRoot: string;
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
  cols: number;
  rows: number;
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
    const scope = await this.projectPathScope(project);
    const id = `ai_${randomUUID().slice(0, 8)}`;
    const branch = `chorus/ai-a-la-carte/${id}`;
    const worktreePath = join(this.projectWorktreesRoot(project.id), "ai-a-la-carte", id);
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.git.addWorktree(scope.basePath, worktreePath, branch, project.baseBranch);
    const createdPath = await realpath(worktreePath);
    const entry = (await this.listWorktreeEntries(project)).find((wt) => normalizePath(wt.path) === normalizePath(createdPath));
    if (!entry) throw new TerminalError(500, "created worktree was not registered by git");
    const { path: _path, ...publicEntry } = entry;
    return publicEntry;
  }

  async createSession(input: {
    projectId: string;
    worktreeId: string;
    backendId?: string | null;
    cols?: number;
    rows?: number;
  }): Promise<TerminalSessionInfo> {
    const project = this.requireProject(input.projectId);
    const scope = await this.projectPathScope(project);
    const worktree = (await this.listWorktreeEntries(project)).find((wt) => wt.id === input.worktreeId);
    if (!worktree) throw new TerminalError(400, "unknown worktree");
    const worktreePath = await realpathIfExists(worktree.path);
    if (!worktreePath) throw new TerminalError(400, "worktree path does not exist");
    if (!this.pathAllowedForProject(scope, worktreePath)) {
      throw new TerminalError(400, "worktree is outside this project");
    }

    const backendId = input.backendId?.trim() || null;
    if (backendId) this.requireAvailableBackend(backendId);

    const token = randomUUID();
    const session: TerminalSession = {
      sessionToken: token,
      token,
      projectId: project.id,
      worktreeId: worktree.id,
      worktreePath,
      backendId,
      mode: backendId ? "backend" : "shell",
      startedAt: Date.now(),
      cols: clampTermSize(input.cols, 80),
      rows: clampTermSize(input.rows, 24),
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
        env: terminalEnv(session.cols, session.rows),
        stdin: "pipe",
        pty: process.platform !== "win32",
        ptyControl: process.platform !== "win32",
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
    let msg: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      msg = JSON.parse(text) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    } catch {
      return;
    }
    if (msg.type === "input" && typeof msg.data === "string") {
      session.proc?.writeStdin(msg.data);
    } else if (msg.type === "resize" && typeof msg.cols === "number" && typeof msg.rows === "number") {
      session.cols = clampTermSize(msg.cols, session.cols);
      session.rows = clampTermSize(msg.rows, session.rows);
      session.proc?.resize(session.cols, session.rows);
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
    const scope = await this.projectPathScope(project);
    const tickets = this.deps.db.listTickets(project.id);
    const ticketByPath = new Map<string, Ticket>();
    for (const ticket of tickets) {
      const path = ticket.worktreePath ? await this.realpathAllowedForProject(scope, ticket.worktreePath) : null;
      if (path) ticketByPath.set(normalizePath(path), ticket);
    }

    let gitWorktrees: GitWorktreeInfo[] = [];
    let gitWorktreesAvailable = false;
    try {
      gitWorktrees = await this.git.listWorktrees(scope.basePath);
      gitWorktreesAvailable = true;
    } catch {
      gitWorktrees = [];
    }

    const entries = new Map<string, TerminalWorktreeEntry>();
    const add = (entry: TerminalWorktreeEntry) => {
      entries.set(normalizePath(entry.path), entry);
    };

    add({
      id: "base",
      label: `${project.baseBranch} (base clone)`,
      branch: project.baseBranch,
      kind: "base",
      path: scope.basePath,
    });

    for (const wt of gitWorktrees) {
      const path = await this.realpathAllowedForProject(scope, wt.path);
      if (!path) continue;
      if (normalizePath(path) === normalizePath(scope.basePath)) continue;
      const ticket = ticketByPath.get(normalizePath(path));
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

    if (!gitWorktreesAvailable) {
      for (const ticket of tickets) {
        if (!ticket.worktreePath || !ticket.branch) continue;
        const path = await this.realpathAllowedForProject(scope, ticket.worktreePath);
        if (!path || entries.has(normalizePath(path))) continue;
        add({
          id: `wt_${hashPath(path)}`,
          label: `${ticket.branch} - ${ticket.title}`,
          branch: ticket.branch,
          kind: "ticket",
          ticketId: ticket.id,
          ticketTitle: ticket.title,
          path,
        });
      }
    }

    return [...entries.values()];
  }

  private async projectPathScope(project: Project): Promise<ProjectPathScope> {
    const basePath = await realpathIfExists(project.localPath);
    if (!basePath) throw new TerminalError(400, "project clone path does not exist");
    const root = this.projectWorktreesRoot(project.id);
    return {
      basePath,
      worktreesRoot: (await realpathIfExists(root)) ?? normalizePath(root),
    };
  }

  private async realpathAllowedForProject(scope: ProjectPathScope, path: string): Promise<string | null> {
    const resolved = await realpathIfExists(path);
    if (!resolved) return null;
    return this.pathAllowedForProject(scope, resolved) ? resolved : null;
  }

  private pathAllowedForProject(scope: ProjectPathScope, path: string): boolean {
    const resolved = normalizePath(path);
    if (resolved === normalizePath(scope.basePath)) return true;
    return isInside(scope.worktreesRoot, resolved);
  }

  private projectWorktreesRoot(projectId: string): string {
    return join(this.deps.config.dataDir, "worktrees", projectId);
  }
}

// This terminal is loopback-only and runs on the user's own machine, so it
// inherits the daemon's full environment for a true "full access" shell. A
// login+interactive shell (see shellArgs) layers the user's own profile on top.
function terminalEnv(cols: number, rows: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.CHORUS_TERMINAL = "1";
  // Seed the PTY size before the shell starts (read by the python PTY bridge).
  env.CHORUS_PTY_COLS = String(cols);
  env.CHORUS_PTY_ROWS = String(rows);
  return env;
}

function clampTermSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(65535, Math.floor(value)));
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
  // Login + interactive so the user's full profile (PATH, aliases, prompt) loads.
  if (name === "zsh" || name === "bash") return ["-l", "-i"];
  return ["-l", "-i"];
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

async function realpathIfExists(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
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
