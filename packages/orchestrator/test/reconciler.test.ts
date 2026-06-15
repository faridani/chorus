import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { GitService } from "@chorus/git-service";
import { Reconciler } from "@chorus/orchestrator";

function freshDb(): ChorusDb {
  const dir = mkdtempSync(join(tmpdir(), "chorus-recon-"));
  return new ChorusDb(join(dir, "test.db"));
}

test("reconcile: interrupted running task with no worktree → ticket reopened, run closed", async () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: join(tmpdir(), "does-not-exist-" + Date.now()),
    integrationBranch: "chorus/integration",
    baseBranch: "main",
    specPath: null,
    status: "ready",
    createdAt: Date.now(),
  });
  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "t",
    body: "b",
    status: "in_progress",
    roleName: "software-dev",
    priority: 0,
    source: "manual",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const taskId = newId("task");
  db.insertTask({
    id: taskId,
    ticketId,
    projectId,
    backendId: "codex",
    worktreePath: join(tmpdir(), "missing-wt-" + Date.now()),
    branch: "chorus/ticket-x",
    baseCommit: "abc",
    state: "running",
    attempt: 1,
    resumeAt: null,
    startedAt: Date.now(),
    endedAt: null,
  });
  const runId = newId("run");
  db.insertRun({
    id: runId,
    taskId,
    pid: 999999,
    pgid: 999999,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    exitSignal: null,
    terminalReason: null,
    rawLogPath: null,
    outputFilePath: null,
  });

  await new Reconciler(db, new GitService()).reconcile();

  assert.equal(db.getTask(taskId)?.state, "interrupted");
  assert.equal(db.getTicket(ticketId)?.status, "open"); // re-opened for a fresh attempt
  assert.equal(db.listUnfinishedRuns().length, 0); // run was closed out
  db.close();
});
