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
  const out = await ctrl.runDebugTraces(projectId, null, [{ type: "agent_event", projectId }]);
  assert.deepEqual(out, CANNED);
  assert.ok(received.prompt?.includes("TRACE DATA"), "prompt should contain the trace block");
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
