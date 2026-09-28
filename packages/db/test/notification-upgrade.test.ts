import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { ChorusDb } from "@chorus/db";
import { MIGRATIONS } from "../src/migrations.js";

test("existing database upgrades and notifications survive reopening with project isolation", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "chorus-notifications-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "test.db");
  const old = new Database(path);
  for (const sql of MIGRATIONS.slice(0, 11)) old.exec(sql);
  old.exec("CREATE TABLE schema_version (version INTEGER NOT NULL); INSERT INTO schema_version VALUES (11)");
  old.close();

  let db = new ChorusDb(path);
  t.after(() => db.close());
  for (const id of ["proj_1", "proj_2"]) {
    db.insertProject({ id, repoUrl: "owner/repo", localPath: dir, baseBranch: "main",
      specPath: null, expectations: "", groundRules: [], status: "ready", runState: "running", createdAt: 1 });
  }
  const record = { id: "ntf_1", projectId: "proj_1", kind: "quota_paused" as const,
    title: "Quota exhausted", body: "Paused until reset", createdAt: 123 };
  db.insertNotification(record);
  db.close();
  db = new ChorusDb(path);
  assert.deepEqual(db.listNotifications("proj_1"), [record]);
  assert.deepEqual(db.listNotifications("proj_2"), []);
  assert.equal(db.getProject("proj_1")?.repoUrl, "owner/repo");
});
