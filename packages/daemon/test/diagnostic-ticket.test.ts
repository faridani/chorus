import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, type DiagnosisResult, newId, ORCHESTRATOR_ROLE, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { AppController, type DiagnoseFn } from "../src/controller.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-diag-")), "t.db"));
}

function makeController(db: ChorusDb, diagnose?: DiagnoseFn): AppController {
  return new AppController({
    db,
    bus: new ChorusBus(),
    git: {} as never,
    backends: {} as never,
    orchestrator: { runningTaskIds: () => [], tick: () => {} } as never,
    notifier: {} as never,
    config: { dataDir: "/tmp", agent: {} } as never,
    detectedBackends: [],
    diagnose,
  });
}

function seedProject(db: ChorusDb): string {
  const id = newId("proj");
  const project: Project = {
    id,
    repoUrl: "owner/repo",
    localPath: join(tmpdir(), "no-clone-" + id),
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: true,
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
  };
  db.insertProject(project);
  return id;
}

const CANNED: DiagnosisResult = {
  status: "needs_ticket",
  summary: "Repeated identical failures.",
  evidence: ["3x same error"],
  risks: ["blocked loop"],
  recommendedAction: "Fix it.",
  ticket: { title: "Fix the loop", body: "details", priority: 0, roleName: "" },
  confidence: 0.9,
};

test("runDebugTraces enriches + returns the (mocked) model result", async () => {
  const db = freshDb();
  const projectId = seedProject(db);
  let received: { cwd?: string; prompt?: string } = {};
  const mock: DiagnoseFn = async (args) => {
    received = { cwd: args.cwd, prompt: args.prompt };
    return CANNED;
  };
  const ctrl = makeController(db, mock);
  const out = await ctrl.runDebugTraces(projectId, null, [
    { type: "agent_event", projectId, event: { kind: "command", command: "npm test", exitCode: 1 } },
  ]);
  assert.deepEqual(out, CANNED);
  assert.ok(received.prompt?.includes("TRACE DATA"), "prompt should contain the trace block");
  // The sanitizer preserves command-event details the diagnostician needs.
  assert.ok(received.prompt?.includes("npm test"), "should preserve the failed command");
  assert.ok(received.prompt?.includes("exitCode"), "should preserve the exit code");
  db.close();
});

test("runDebugTraces 404s for a ticket not in the project", async () => {
  const db = freshDb();
  const projectId = seedProject(db);
  const otherId = seedProject(db);
  // A ticket that belongs to a different project.
  const tid = newId("tkt");
  db.insertTicket({
    id: tid,
    projectId: otherId,
    title: "t",
    body: "b",
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
  const ctrl = makeController(db, async () => CANNED);
  await assert.rejects(() => ctrl.runDebugTraces(projectId, tid, []), /No such ticket/);
  db.close();
});

test("runDebugTraces 404s for an unknown project", async () => {
  const db = freshDb();
  const ctrl = makeController(db, async () => CANNED);
  await assert.rejects(() => ctrl.runDebugTraces("proj_nope", null, []), /No such project/);
  db.close();
});

test("filing a diagnostic ticket: orchestrator by default + audit event", async () => {
  const db = freshDb();
  const projectId = seedProject(db);
  const ctrl = makeController(db);
  const t = await ctrl.addTicket(projectId, {
    title: "Fix the loop",
    body: "details",
    priority: 100,
    fromDiagnostic: true,
  });
  assert.equal(t.roleName, ORCHESTRATOR_ROLE);
  assert.equal(t.priority, 100);
  const events = db.listTicketEvents(t.id);
  assert.ok(
    events.some((e) => e.kind === "note" && /Trace Diagnosis/.test(e.message)),
    "audit ticket_event should be recorded",
  );
  db.close();
});

test("setTicketStarred toggles the flag even while the ticket's agent is running", async () => {
  const db = freshDb();
  const projectId = seedProject(db);
  const ctrl = makeController(db);
  const t = await ctrl.addTicket(projectId, { title: "Star me", body: "b" });
  assert.equal(t.starred, false);

  // A controller whose orchestrator reports this ticket as actively running —
  // updateTicket would 409 here, but starring must still work.
  const events: string[] = [];
  const bus = new ChorusBus();
  bus.on((e) => e.type === "ticket_changed" && events.push(e.ticketId));
  const runningCtrl = new AppController({
    db,
    bus,
    git: {} as never,
    backends: {} as never,
    orchestrator: { runningTaskIds: () => [t.id], tick: () => {} } as never,
    notifier: {} as never,
    config: { dataDir: "/tmp", agent: {} } as never,
    detectedBackends: [],
  });

  const starred = await runningCtrl.setTicketStarred(projectId, t.id, true);
  assert.equal(starred.starred, true);
  assert.equal(db.getTicket(t.id)?.starred, true);
  assert.ok(events.includes(t.id), "emits ticket_changed");

  const unstarred = await runningCtrl.setTicketStarred(projectId, t.id, false);
  assert.equal(unstarred.starred, false);

  assert.throws(() => runningCtrl.setTicketStarred("proj_nope", t.id, true), /ticket not found/);
  db.close();
});

test("filing honors a valid proposed role, ignores an invalid one", async () => {
  const db = freshDb();
  const projectId = seedProject(db);
  db.insertRole({
    id: newId("role"),
    projectId,
    name: "software-dev",
    description: "dev",
    allowed: [],
    forbidden: [],
    allowedToolIds: [],
    forbiddenToolIds: [],
    backendId: "codex",
  });
  const ctrl = makeController(db);
  const valid = await ctrl.addTicket(projectId, { title: "a", body: "b", roleName: "software-dev" });
  assert.equal(valid.roleName, "software-dev");
  const invalid = await ctrl.addTicket(projectId, { title: "c", body: "d", roleName: "ghost" });
  assert.equal(invalid.roleName, ORCHESTRATOR_ROLE);
  db.close();
});
