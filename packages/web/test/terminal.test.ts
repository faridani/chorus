import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, type BackendInfo, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { createServer } from "@chorus/web";

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

function setup(opts: { backends?: BackendInfo[] } = {}) {
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
    config: { dataDir, host: "127.0.0.1", port: 0, maxConcurrentAgents: 1 } as never,
    version: { number: "0.0.0", commit: "test", dirty: false, startedAt: 0 },
  });
  return {
    app,
    db,
    project,
    repoPath,
    close: async () => {
      await app.close();
      db.close();
    },
  };
}
