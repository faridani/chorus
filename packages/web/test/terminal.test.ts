import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ChorusBus, type BackendInfo, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { createServer, isLocalDaemonRequest } from "@chorus/web";

test("terminal APIs reject non-loopback clients", async () => {
  const fixture = setup();
  const res = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "10.0.0.8",
  });
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.json(), { error: "loopback only" });
  await fixture.close();
});

test("terminal request guard handles uppercase and missing request addresses", () => {
  assert.equal(isLocalDaemonRequest("::FFFF:127.0.0.1", "127.0.0.1"), true);
  assert.equal(isLocalDaemonRequest("::FFFF:192.0.2.10", "::ffff:192.0.2.10"), true);
  assert.equal(isLocalDaemonRequest(undefined, "127.0.0.1"), false);
  assert.equal(isLocalDaemonRequest("127.0.0.1", undefined), false);
});

test("terminal guard accepts the configured local bind address and rejects other remote clients", async () => {
  const fixture = setup({ host: "192.0.2.10" });

  const local = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "192.0.2.10",
  });
  assert.equal(local.statusCode, 200);

  const mappedLocal = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "::ffff:192.0.2.10",
  });
  assert.equal(mappedLocal.statusCode, 200);

  const upperMappedLocal = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "::FFFF:192.0.2.10",
  });
  assert.equal(upperMappedLocal.statusCode, 200);

  const remote = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "10.0.0.8",
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(remote.json(), { error: "loopback only" });

  await fixture.app.ready();
  assert.deepEqual(await terminalSocketClose(fixture, "192.0.2.10"), {
    code: 1008,
    reason: "unknown terminal session",
  });
  assert.deepEqual(await terminalSocketClose(fixture, "::ffff:192.0.2.10"), {
    code: 1008,
    reason: "unknown terminal session",
  });
  assert.deepEqual(await terminalSocketClose(fixture, "10.0.0.8"), {
    code: 1008,
    reason: "loopback only",
  });

  await fixture.close();
});

test("terminal guard normalizes IPv4-mapped configured bind addresses", async () => {
  const fixture = setup({ host: "::FFFF:192.0.2.10" });

  const local = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "192.0.2.10",
  });
  assert.equal(local.statusCode, 200);

  const remote = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "10.0.0.8",
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(remote.json(), { error: "loopback only" });

  await fixture.close();
});

test("terminal guard accepts local interface clients when bound to wildcard", async () => {
  const fixture = setup({
    host: "0.0.0.0",
    localAddresses: ["192.0.2.10", "::ffff:198.51.100.4"],
  });

  const local = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "192.0.2.10",
  });
  assert.equal(local.statusCode, 200);

  const mappedLocal = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "::FFFF:198.51.100.4",
  });
  assert.equal(mappedLocal.statusCode, 200);

  const remote = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
    remoteAddress: "10.0.0.8",
  });
  assert.equal(remote.statusCode, 403);
  assert.deepEqual(remote.json(), { error: "loopback only" });

  await fixture.app.ready();
  assert.deepEqual(await terminalSocketClose(fixture, "192.0.2.10"), {
    code: 1008,
    reason: "unknown terminal session",
  });
  assert.deepEqual(await terminalSocketClose(fixture, "::FFFF:198.51.100.4"), {
    code: 1008,
    reason: "unknown terminal session",
  });
  assert.deepEqual(await terminalSocketClose(fixture, "10.0.0.8"), {
    code: 1008,
    reason: "loopback only",
  });

  await fixture.close();
});

test("terminal worktree listing is project scoped and does not expose paths", async () => {
  const fixture = setup();
  const res = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Array<{ id: string; label: string; branch: string; path?: string }>;
  assert.deepEqual(body, [{ id: "base", label: "main (base clone)", branch: "main", kind: "base" }]);
  assert.equal(JSON.stringify(body).includes(fixture.repoPath), false);
  await fixture.close();
});

test("terminal session creation validates worktrees and available backends", async () => {
  const fixture = setup({
    backends: [
      {
        id: "codex",
        label: "Codex",
        bin: "codex",
        available: false,
        version: null,
        models: [],
        defaultModel: null,
        implemented: true,
      },
    ],
  });

  const unknown = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/terminal/sessions`,
    payload: { worktreeId: "wt_missing" },
  });
  assert.equal(unknown.statusCode, 400);
  assert.deepEqual(unknown.json(), { error: "unknown worktree" });

  const unavailable = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/terminal/sessions`,
    payload: { worktreeId: "base", backendId: "codex" },
  });
  assert.equal(unavailable.statusCode, 400);
  assert.deepEqual(unavailable.json(), { error: "backend is not available" });

  const shell = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/terminal/sessions`,
    payload: { worktreeId: "base" },
  });
  assert.equal(shell.statusCode, 200);
  const session = shell.json() as { sessionToken: string; worktreePath?: string; backendId: string | null };
  assert.equal(typeof session.sessionToken, "string");
  assert.equal(session.backendId, null);
  assert.equal("worktreePath" in session, false);

  const stop = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/terminal/sessions/${session.sessionToken}/stop`,
  });
  assert.equal(stop.statusCode, 200);
  assert.deepEqual(stop.json(), { ok: true });
  await fixture.close();
});

test("terminal worktrees must be git-registered and realpath scoped", async () => {
  const fixture = setup();
  const worktreesRoot = join(fixture.dataDir, "worktrees", fixture.project.id);
  mkdirSync(worktreesRoot, { recursive: true });

  const registered = join(worktreesRoot, "registered");
  execFileSync("git", ["worktree", "add", "-b", "ticket-registered", registered, "main"], {
    cwd: fixture.repoPath,
  });
  fixture.db.insertTicket({
    id: "ticket_registered",
    projectId: fixture.project.id,
    title: "Registered ticket",
    body: "",
    status: "in_progress",
    roleName: null,
    priority: 1,
    source: "manual",
    branch: "ticket-registered",
    worktreePath: registered,
    prUrl: null,
    prNumber: null,
    starred: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const stale = join(worktreesRoot, "stale-db-path");
  mkdirSync(stale, { recursive: true });
  fixture.db.insertTicket({
    id: "ticket_stale",
    projectId: fixture.project.id,
    title: "Stale DB ticket",
    body: "",
    status: "in_progress",
    roleName: null,
    priority: 1,
    source: "manual",
    branch: "ticket-stale",
    worktreePath: stale,
    prUrl: null,
    prNumber: null,
    starred: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  if (process.platform !== "win32") {
    const outside = join(fixture.root, "outside-worktree");
    mkdirSync(outside, { recursive: true });
    const symlink = join(worktreesRoot, "symlink-outside");
    symlinkSync(outside, symlink, "dir");
    fixture.db.insertTicket({
      id: "ticket_symlink",
      projectId: fixture.project.id,
      title: "Symlink escape ticket",
      body: "",
      status: "in_progress",
      roleName: null,
      priority: 1,
      source: "manual",
      branch: "ticket-symlink",
      worktreePath: symlink,
      prUrl: null,
      prNumber: null,
      starred: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  const listed = await fixture.app.inject({
    method: "GET",
    url: `/api/projects/${fixture.project.id}/terminal/worktrees`,
  });
  assert.equal(listed.statusCode, 200);
  const body = listed.json() as Array<{ branch: string; kind: string; path?: string }>;
  assert.equal(body.some((wt) => wt.branch === "ticket-registered" && wt.kind === "ticket"), true);
  assert.equal(body.some((wt) => wt.branch === "ticket-stale"), false);
  assert.equal(body.some((wt) => wt.branch === "ticket-symlink"), false);
  assert.equal(JSON.stringify(body).includes(worktreesRoot), false);

  const staleSession = await fixture.app.inject({
    method: "POST",
    url: `/api/projects/${fixture.project.id}/terminal/sessions`,
    payload: { worktreeId: worktreeIdForPath(stale) },
  });
  assert.equal(staleSession.statusCode, 400);
  assert.deepEqual(staleSession.json(), { error: "unknown worktree" });

  await fixture.close();
});

function setup(opts: { backends?: BackendInfo[]; host?: string; localAddresses?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "chorus-web-terminal-"));
  const dataDir = join(root, "data");
  const repoPath = join(root, "repo");
  execFileSync("git", ["init", "-b", "main", repoPath]);
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath });
  execFileSync(
    "git",
    ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"],
    { cwd: repoPath },
  );

  const db = new ChorusDb(join(root, "t.db"));
  const project: Project = {
    id: "proj_terminal",
    repoUrl: "https://github.com/example/repo",
    localPath: repoPath,
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: false,
    status: "ready",
    runState: "running",
    idleIdeation: false,
    idleIdeationCount: 1,
    createdAt: Date.now(),
  };
  db.insertProject(project);
  const app = createServer({
    db,
    bus: new ChorusBus(),
    api: { listBackends: () => opts.backends ?? [] } as never,
    config: { dataDir, host: opts.host ?? "127.0.0.1", port: 0, maxConcurrentAgents: 1 } as never,
    version: { number: "0.0.0", commit: "test", dirty: false, startedAt: 0 },
    localInterfaceAddresses: opts.localAddresses ? () => opts.localAddresses ?? [] : undefined,
  });
  return {
    app,
    db,
    project,
    root,
    dataDir,
    repoPath,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}

function worktreeIdForPath(path: string): string {
  return `wt_${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
}

async function terminalSocketClose(
  fixture: ReturnType<typeof setup>,
  remoteAddress: string,
): Promise<{ code: number; reason: string }> {
  let resolveClose!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    resolveClose = resolve;
  });
  await fixture.app.injectWS(
    "/ws/terminal/missing",
    { socket: { remoteAddress } } as never,
    {
      onInit: (ws) => {
        ws.once("close", (code, reason) => {
          resolveClose({ code, reason: reason.toString("utf8") });
        });
      },
    },
  );
  return closed;
}
