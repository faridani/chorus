import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, newId } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { createServer } from "@chorus/web";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-web-")), "t.db"));
}

test("project detail API includes recent persisted notifications", async () => {
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
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: true,
    status: "ready",
    runState: "running",
    idleIdeation: false,
    idleIdeationCount: 1,
    createdAt: Date.now(),
  });
  db.insertNotification({
    id: "ntf_1",
    projectId,
    kind: "needs_review",
    title: "Needs human",
    body: "Review required",
    createdAt: 123,
  });

  const app = createServer({
    db,
    bus: new ChorusBus(),
    api: {} as never,
    config: { dataDir: "/tmp", host: "127.0.0.1", port: 0, maxConcurrentAgents: 1 } as never,
    version: { number: "0.0.0", commit: "test", dirty: false, startedAt: 0 },
  });

  const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { notifications: Array<{ id: string; kind: string; title: string }> };
  assert.equal(body.notifications.length, 1);
  assert.equal(body.notifications[0]?.id, "ntf_1");
  assert.equal(body.notifications[0]?.kind, "needs_review");
  assert.equal(body.notifications[0]?.title, "Needs human");

  await app.close();
  db.close();
});
