import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, newId, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { AppController } from "../src/controller.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-builtin-")), "t.db"));
}

function makeController(db: ChorusDb): AppController {
  return new AppController({
    db,
    bus: new ChorusBus(),
    git: {} as never,
    backends: {} as never,
    orchestrator: { runningTaskIds: () => [] } as never,
    notifier: {} as never,
    config: { dataDir: "/tmp" } as never,
    detectedBackends: [],
  });
}

function insertProject(db: ChorusDb, overrides: Partial<Project> = {}): string {
  const id = newId("proj");
  db.insertProject({
    id,
    repoUrl: "owner/repo",
    localPath: "/tmp/repo",
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
    ...overrides,
  });
  return id;
}

test("controller applies a built-in agent to a project role without persisting it as a custom template", async () => {
  const db = freshDb();
  const controller = makeController(db);
  const projectId = insertProject(db);

  const role = await controller.applyTemplate(projectId, {
    source: "builtin",
    id: "software-engineer",
  });

  assert.equal(role.name, "software-engineer");
  assert.match(role.description, /Implements backend and frontend changes/);
  assert.ok(role.allowedToolIds.includes("repo.modify"));
  assert.ok(role.allowedToolIds.includes("verify.run"));
  assert.equal(db.getAgentTemplate("software-engineer"), undefined);
  assert.equal(db.getRole(projectId, "software-engineer")?.id, role.id);
  db.close();
});

test("explicit built-in apply does not overwrite a user template with the same name", async () => {
  const db = freshDb();
  const controller = makeController(db);
  const projectId = insertProject(db);
  db.insertAgentTemplate({
    id: "tmpl_same_name",
    name: "software-engineer",
    description: "User customized engineer",
    allowed: ["custom allowed"],
    forbidden: ["custom forbidden"],
    allowedToolIds: ["repo.read"],
    forbiddenToolIds: [],
    backendId: "codex",
    createdAt: Date.now(),
  });

  const customRole = await controller.applyTemplate(projectId, "software-engineer");
  assert.equal(customRole.description, "User customized engineer");

  const builtInRole = await controller.applyTemplate(projectId, {
    source: "builtin",
    id: "software-engineer",
  });
  assert.match(builtInRole.description, /Implements backend and frontend changes/);
  assert.equal(db.getAgentTemplate("software-engineer")?.description, "User customized engineer");
  db.close();
});
