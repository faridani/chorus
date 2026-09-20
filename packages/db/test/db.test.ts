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

test("project idle-ideation fields default and round-trip", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    runState: "running",
    status: "ready",
    createdAt: Date.now(),
  });
  // Defaults when not supplied: off, count 1.
  assert.equal(db.getProject(projectId)?.idleIdeation, false);
  assert.equal(db.getProject(projectId)?.idleIdeationCount, 1);

  db.updateProject(projectId, { idleIdeation: true, idleIdeationCount: 5 });
  assert.equal(db.getProject(projectId)?.idleIdeation, true);
  assert.equal(db.getProject(projectId)?.idleIdeationCount, 5);

  db.updateProject(projectId, { idleIdeation: false });
  assert.equal(db.getProject(projectId)?.idleIdeation, false);
  assert.equal(db.getProject(projectId)?.idleIdeationCount, 5, "count unchanged when only toggling");
  db.close();
});

test("ticket starred flag defaults false and round-trips", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    runState: "running",
    status: "ready",
    createdAt: Date.now(),
  });
  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "Star me",
    body: "details",
    status: "open",
    roleName: null,
    priority: 1,
    source: "manual",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(db.getTicket(ticketId)?.starred, false, "defaults to unstarred");

  db.updateTicket(ticketId, { starred: true });
  assert.equal(db.getTicket(ticketId)?.starred, true);
  db.updateTicket(ticketId, { starred: false });
  assert.equal(db.getTicket(ticketId)?.starred, false);
  db.close();
});

test("project + ticket + task round-trip", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: "docs/SPEC.md",
    expectations: "",
    groundRules: [],
    runState: "running",
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
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
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
    baseBranch: "main",
    specPath: null,
    expectations: "Build a great thing",
    groundRules: ["rule one", "rule two"],
    runState: "running",
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

  // migration 0003: run_state round-trips and is independently updatable.
  assert.equal(got.runState, "running");
  db.updateProject(id, { runState: "paused" });
  assert.equal(db.getProject(id)!.runState, "paused");
  db.updateProject(id, { runState: "stopped" });
  assert.equal(db.getProject(id)!.runState, "stopped");
  db.close();
});

test("ticket delete + role update/delete", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    runState: "running",
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
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
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
    backendId: "claude",
    model: "sonnet",
  });
  const r = db.getRole(projectId, "qa")!;
  assert.equal(r.description, "updated");
  assert.deepEqual(r.allowed, ["run tests", "file bugs"]);
  assert.equal(r.backendId, "claude");
  assert.equal(r.model, "sonnet");

  db.deleteRole(projectId, "qa");
  assert.equal(db.getRole(projectId, "qa"), undefined);
  db.close();
});

test("migration 0005: ticket branch/worktree, trail events, suggestions", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  });
  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "t",
    body: "b",
    status: "open",
    roleName: "orchestrator",
    priority: 0,
    source: "manual",
    branch: "chorus/ticket-x",
    worktreePath: "/tmp/wt",
    prUrl: null,
    prNumber: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const got = db.getTicket(ticketId)!;
  assert.equal(got.branch, "chorus/ticket-x");
  assert.equal(got.worktreePath, "/tmp/wt");
  db.updateTicket(ticketId, { branch: null, worktreePath: null, status: "merged" });
  assert.equal(db.getTicket(ticketId)!.branch, null);

  db.insertTicketEvent({
    id: newId("te"),
    projectId,
    ticketId,
    actor: "orchestrator",
    kind: "triage",
    message: "assigned to software-dev",
    createdAt: Date.now(),
  });
  assert.equal(db.listTicketEvents(ticketId).length, 1);
  assert.equal(db.listProjectTicketEvents(projectId)[0]?.actor, "orchestrator");

  const sid = newId("sug");
  db.insertSuggestion({
    id: sid,
    projectId,
    ticketId,
    message: "Create a Security agent",
    status: "open",
    createdAt: Date.now(),
  });
  assert.equal(db.listSuggestions(projectId, "open").length, 1);
  db.setSuggestionStatus(sid, "dismissed");
  assert.equal(db.listSuggestions(projectId, "open").length, 0);
  assert.equal(db.listSuggestions(projectId, "dismissed").length, 1);
  db.close();
});

test("migration 0006: ticket pr fields + pull_requests round-trip", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  });
  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "t",
    body: "b",
    status: "pr_open",
    roleName: "orchestrator",
    priority: 0,
    source: "manual",
    branch: "chorus/ticket-x",
    worktreePath: null,
    prUrl: "https://github.com/owner/repo/pull/7",
    prNumber: 7,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const t = db.getTicket(ticketId)!;
  assert.equal(t.prUrl, "https://github.com/owner/repo/pull/7");
  assert.equal(t.prNumber, 7);

  const prId = newId("pr");
  db.insertPullRequest({
    id: prId,
    ticketId,
    projectId,
    url: "https://github.com/owner/repo/pull/7",
    number: 7,
    state: "OPEN",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(db.listPullRequests(projectId).length, 1);
  assert.equal(db.listPullRequests(projectId)[0]?.state, "OPEN");
  assert.equal(db.listOpenPullRequests(projectId).length, 1);
  db.updatePullRequestState(prId, "MERGED");
  assert.equal(db.listPullRequests(projectId)[0]?.state, "MERGED");
  assert.equal(db.listOpenPullRequests(projectId).length, 0);

  const reopenedPrId = newId("pr");
  db.insertPullRequest({
    id: reopenedPrId,
    ticketId,
    projectId,
    url: "https://github.com/owner/repo/pull/8",
    number: 8,
    state: "OPEN",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(
    db.updatePullRequestStateForTicket(ticketId, "CLOSED", {
      number: 8,
      url: "https://github.com/owner/repo/pull/8",
    }),
    1,
  );
  assert.equal(db.listPullRequests(projectId).find((p) => p.number === 8)?.state, "CLOSED");
  assert.equal(db.listOpenPullRequests(projectId).length, 0);

  const urlOnly = "https://github.com/owner/repo/pull/9";
  db.insertPullRequest({
    id: newId("pr"),
    ticketId,
    projectId,
    url: urlOnly,
    number: null,
    state: "OPEN",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(db.updatePullRequestStateForTicket(ticketId, "MERGED", { number: 9, url: urlOnly }), 1);
  assert.equal(db.listPullRequests(projectId).find((p) => p.url === urlOnly)?.state, "MERGED");
  assert.equal(db.listOpenPullRequests(projectId).length, 0);

  assert.equal(db.listTicketsByStatus(projectId, "pr_open").length, 1);
  db.close();
});

test("migration 0007: project commands + attempt journal + pr task_id", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: "npm install",
    verifyCommands: ["npm run build", "npm test"],
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  });
  const p = db.getProject(projectId)!;
  assert.equal(p.setupCommand, "npm install");
  assert.deepEqual(p.verifyCommands, ["npm run build", "npm test"]);
  db.updateProject(projectId, { verifyCommands: ["npm test"] });
  assert.deepEqual(db.getProject(projectId)!.verifyCommands, ["npm test"]);

  const ticketId = newId("tkt");
  db.insertTicket({
    id: ticketId,
    projectId,
    title: "t",
    body: "b",
    status: "open",
    roleName: "software-dev",
    priority: 0,
    source: "manual",
    branch: "chorus/ticket-x",
    worktreePath: "/tmp/wt",
    prUrl: null,
    prNumber: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });

  const taskId = newId("task");
  db.insertAttemptJournal({
    id: newId("aj"),
    taskId,
    ticketId,
    projectId,
    attempt: 1,
    promptHash: "abc123",
    diffHash: "def456",
    verifyPassed: false,
    verifyOutput: "npm test\nFAIL src/x.test.ts",
    diagnosis: "Test x expects Y",
    nextAction: "reassign-to-worker",
    evaluatorVerdict: JSON.stringify({ passed: false }),
    reviewerVerdict: null,
    proof: null,
    createdAt: Date.now(),
  });
  const journal = db.listAttemptJournal(ticketId);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]?.verifyPassed, false);
  assert.equal(journal[0]?.diagnosis, "Test x expects Y");
  assert.equal(db.latestAttemptJournal(ticketId)?.taskId, taskId);
  assert.equal(db.listProjectAttemptJournal(projectId).length, 1);

  // pull_requests.task_id round-trips.
  db.insertPullRequest({
    id: newId("pr"),
    ticketId,
    projectId,
    taskId,
    url: "https://github.com/owner/repo/pull/3",
    number: 3,
    state: "OPEN",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  assert.equal(db.listPullRequests(projectId)[0]?.taskId, taskId);
  db.close();
});

test("migration 0008: tool permissions default empty + round-trip on role & template", () => {
  const db = freshDb();
  const projectId = newId("proj");
  db.insertProject({
    id: projectId,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  });

  // Inserted without tool fields → defaults to empty arrays.
  const roleId = newId("role");
  db.insertRole({
    id: roleId,
    projectId,
    name: "legacy",
    description: "no tools set",
    allowed: [],
    forbidden: [],
    backendId: "codex",
  } as never);
  assert.deepEqual(db.getRole(projectId, "legacy")!.allowedToolIds, []);
  assert.deepEqual(db.getRole(projectId, "legacy")!.forbiddenToolIds, []);
  db.raw
    .prepare("UPDATE roles SET allowed_tool_ids='not-json', forbidden_tool_ids='null' WHERE id=?")
    .run(roleId);
  assert.deepEqual(db.getRole(projectId, "legacy")!.allowedToolIds, []);
  assert.deepEqual(db.getRole(projectId, "legacy")!.forbiddenToolIds, []);

  // Round-trip non-empty tool ids on a role.
  db.insertRole({
    id: newId("role"),
    projectId,
    name: "dev",
    description: "coder",
    allowed: [],
    forbidden: [],
    allowedToolIds: ["repo.read", "repo.modify", "verify.run"],
    forbiddenToolIds: ["prs.open.request"],
    backendId: "codex",
  });
  const dev = db.getRole(projectId, "dev")!;
  assert.deepEqual(dev.allowedToolIds, ["repo.read", "repo.modify", "verify.run"]);
  assert.deepEqual(dev.forbiddenToolIds, ["prs.open.request"]);
  db.updateRole({ ...dev, allowedToolIds: ["repo.read"], forbiddenToolIds: [] });
  assert.deepEqual(db.getRole(projectId, "dev")!.allowedToolIds, ["repo.read"]);

  // Round-trip on an agent template.
  db.insertAgentTemplate({
    id: newId("tmpl"),
    name: "qa",
    description: "tester",
    allowed: [],
    forbidden: [],
    allowedToolIds: ["repo.read", "verify.run"],
    forbiddenToolIds: ["repo.modify"],
    backendId: "gemini",
    model: "gemini-2.5-flash",
    createdAt: Date.now(),
  });
  const tmpl = db.getAgentTemplate("qa")!;
  assert.deepEqual(tmpl.allowedToolIds, ["repo.read", "verify.run"]);
  assert.deepEqual(tmpl.forbiddenToolIds, ["repo.modify"]);
  assert.equal(tmpl.backendId, "gemini");
  assert.equal(tmpl.model, "gemini-2.5-flash");
  db.raw
    .prepare("UPDATE agent_templates SET allowed_tool_ids='{}', forbidden_tool_ids='not-json' WHERE id=?")
    .run(tmpl.id);
  assert.deepEqual(db.getAgentTemplate("qa")!.allowedToolIds, []);
  assert.deepEqual(db.getAgentTemplate("qa")!.forbiddenToolIds, []);
  db.close();
});

test("migration 0009: commands_detected defaults false + round-trips", () => {
  const db = freshDb();
  const id = newId("proj");
  db.insertProject({
    id,
    repoUrl: "owner/repo",
    localPath: "/tmp/x",
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  } as never); // omit commandsDetected → defaults false
  assert.equal(db.getProject(id)!.commandsDetected, false);
  db.updateProject(id, { commandsDetected: true });
  assert.equal(db.getProject(id)!.commandsDetected, true);
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
