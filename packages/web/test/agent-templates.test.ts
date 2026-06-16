import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { createServer } from "@chorus/web";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-web-")), "t.db"));
}

test("agent templates API returns built-in and custom templates distinctly", async () => {
  const db = freshDb();
  db.insertAgentTemplate({
    id: "tmpl_custom",
    name: "custom-reviewer",
    description: "User custom reviewer",
    allowed: ["read PR comments"],
    forbidden: [],
    allowedToolIds: ["prs.read"],
    forbiddenToolIds: [],
    backendId: "codex",
    createdAt: Date.now(),
  });
  const app = createServer({
    db,
    bus: new ChorusBus(),
    api: {} as never,
    config: { dataDir: "/tmp", host: "127.0.0.1", port: 0, maxConcurrentAgents: 1 } as never,
    version: { number: "0.0.0", commit: "test", dirty: false, startedAt: 0 },
  });

  const res = await app.inject({ method: "GET", url: "/api/agent-templates" });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Array<{ name: string; source: string; readOnly: boolean; displayName: string }>;
  assert.ok(body.some((t) => t.name === "software-engineer" && t.source === "builtin" && t.readOnly));
  assert.ok(
    body.some(
      (t) =>
        t.name === "custom-reviewer" &&
        t.displayName === "custom-reviewer" &&
        t.source === "custom" &&
        !t.readOnly,
    ),
  );

  await app.close();
  db.close();
});
