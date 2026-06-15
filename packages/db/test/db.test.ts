import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newId } from "@chorus/core";
import { ChorusDb } from "@chorus/db";

function freshDb(): ChorusDb {
  const dir = mkdtempSync(join(tmpdir(), "chorus-db-"));
  return new ChorusDb(join(dir, "test.db"));
}

test("migrations run and schema_version is set", () => {
  const db = freshDb();
  const v = db.raw.prepare("SELECT version FROM schema_version").get() as { version: number };
  assert.ok(v.version >= 1);
  db.close();
});

test("project + ticket + task round-trip", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    integrationBranch: "chorus/integration",
    baseBranch: "main",
    specPath: "docs/SPEC.md",
    status: "ready",
    createdAt: Date.now(),
  });
  assert.equal(db.getProject(projectId)?.repoUrl, "owner/repo");

  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "Do a thing",
    body: "details",
    status: "open",
    roleName: "software-dev",
    priority: 5,
    source: "spec",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(db.nextOpenTicket(projectId)?.id, ticketId);

  db.updateTicket(ticketId, { status: "in_progress" });
  assert.equal(db.getTicket(ticketId)?.status, "in_progress");
  assert.equal(db.nextOpenTicket(projectId), undefined);

  const taskId = newId("task");
  db.insertTask({
    id: taskId,
    ticketId,
    projectId,
    backendId: "codex",
    worktreePath: "/tmp/wt",
    branch: "chorus/ticket-x",
    baseCommit: "abc",
    state: "running",
    attempt: 1,
    resumeAt: null,
    startedAt: Date.now(),
    endedAt: null,
  });
  assert.equal(db.listTasksByState("running").length, 1);
  db.updateTask(taskId, { state: "merged" });
  assert.equal(db.listTasksByState("running").length, 0);

  db.close();
});

test("quota singleton defaults and updates", () => {
  const db = freshDb();
  assert.equal(db.getQuota().state, "available");
  db.setQuota({ state: "exhausted", resumeAt: 123, consecutivePauses: 2, updatedAt: Date.now() });
  const q = db.getQuota();
  assert.equal(q.state, "exhausted");
  assert.equal(q.resumeAt, 123);
  assert.equal(q.consecutivePauses, 2);
  db.close();
});

test("usage totals sum across events", () => {
  const db = freshDb();
  db.insertUsage({
    id: newId("usage"),
    runId: null,
    projectId: null,
    kind: "tokens",
    inputTokens: 100,
    outputTokens: 40,
    detail: null,
    observedAt: Date.now(),
  });
  db.insertUsage({
    id: newId("usage"),
    runId: null,
    projectId: null,
    kind: "tokens",
    inputTokens: 50,
    outputTokens: 10,
    detail: null,
    observedAt: Date.now(),
  });
  const totals = db.usageTotals();
  assert.equal(totals.inputTokens, 150);
  assert.equal(totals.outputTokens, 50);
  db.close();
});
