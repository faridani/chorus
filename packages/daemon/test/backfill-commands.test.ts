import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, newId, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { AppController } from "../src/controller.js";

function makeController(db: ChorusDb): AppController {
  // backfillProjectCommands only touches deps.db and deps.bus (via emitProject);
  // the rest can be stubbed.
  return new AppController({
    db,
    bus: new ChorusBus(),
    git: {} as never,
    backends: {} as never,
    orchestrator: {} as never,
    notifier: {} as never,
    config: { dataDir: "/tmp" } as never,
    detectedBackends: [],
  });
}

function insertProject(db: ChorusDb, over: Partial<Project>): string {
  const id = newId("proj");
  db.insertProject({
    id,
    repoUrl: "owner/repo",
    localPath: join(tmpdir(), "no-such-clone-" + id), // no package.json → detection empty
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: false,
    status: "ready",
    runState: "running",
    createdAt: Date.now(),
    ...over,
  });
  return id;
}

test("backfill never clobbers existing commands when detection is empty", () => {
  const db = new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-bf-")), "t.db"));
  const ctrl = makeController(db);
  // A project that already has commands (e.g. set manually) but predates the
  // detection flag, whose clone yields no detection.
  const id = insertProject(db, {
    setupCommand: "npm install && npm run build",
    verifyCommands: ["npm run build", "npm test"],
  });

  ctrl.backfillProjectCommands();

  const p = db.getProject(id)!;
  assert.equal(p.commandsDetected, true, "should be marked handled");
  assert.equal(p.setupCommand, "npm install && npm run build", "must not clobber setup");
  assert.deepEqual(p.verifyCommands, ["npm run build", "npm test"], "must not clobber verify");
  db.close();
});

test("backfill marks empty-detection projects handled (runs once)", () => {
  const db = new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-bf-")), "t.db"));
  const ctrl = makeController(db);
  const id = insertProject(db, {}); // no commands, no detectable clone

  ctrl.backfillProjectCommands();

  const p = db.getProject(id)!;
  assert.equal(p.commandsDetected, true, "marked handled so it won't re-run every boot");
  assert.equal(p.setupCommand, null);
  assert.deepEqual(p.verifyCommands, []);
  db.close();
});
