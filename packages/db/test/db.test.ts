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
    expectations: "",
    groundRules: [],
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

test("migration 0002: project round-trips expectations + ground rules", () => {
  const db = freshDb();
  const id = newId("proj");
  db.insertProject({
    id,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    integrationBranch: "chorus/integration",
    baseBranch: "main",
    specPath: null,
    expectations: "Build a great thing",
    groundRules: ["rule one", "rule two"],
    status: "ready",
    createdAt: Date.now(),
  });
  const got = db.getProject(id)!;
  assert.equal(got.expectations, "Build a great thing");
  assert.deepEqual(got.groundRules, ["rule one", "rule two"]);

  db.updateProject(id, { expectations: "new vision", groundRules: ["only one"], baseBranch: "develop" });
  const upd = db.getProject(id)!;
  assert.equal(upd.expectations, "new vision");
  assert.deepEqual(upd.groundRules, ["only one"]);
  assert.equal(upd.baseBranch, "develop");
  db.close();
});

test("ticket delete + role update/delete", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    integrationBranch: "chorus/integration",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    status: "ready",
    createdAt: Date.now(),
  });

  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "x",
    body: "y",
    status: "open",
    roleName: null,
    priority: 0,
    source: "manual",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.ok(db.getTicket(ticketId));
  db.deleteTicket(ticketId);
  assert.equal(db.getTicket(ticketId), undefined);

  const roleId = newId("role");
  db.insertRole({
    id: roleId,
    projectId,
    name: "qa",
    description: "tester",
    allowed: ["run tests"],
    forbidden: [],
    backendId: "codex",
  });
  db.updateRole({
    id: roleId,
    projectId,
    name: "qa",
    description: "updated",
    allowed: ["run tests", "file bugs"],
    forbidden: ["edit prod"],
    backendId: "codex",
    model: "gpt-x",
  });
  const r = db.getRole(projectId, "qa")!;
  assert.equal(r.description, "updated");
  assert.deepEqual(r.allowed, ["run tests", "file bugs"]);
  assert.equal(r.model, "gpt-x");

  db.deleteRole(projectId, "qa");
  assert.equal(db.getRole(projectId, "qa"), undefined);
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
