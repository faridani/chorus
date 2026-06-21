import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, TICKET_CLEANUP_CONFIRMATION, type CleanupTicketsInput } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { createServer } from "@chorus/web";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-web-cleanup-")), "t.db"));
}

test("ticket cleanup API forwards cleanup options to the control API", async () => {
  const db = freshDb();
  let received: { projectId: string; input: CleanupTicketsInput } | undefined;
  const app = createServer({
    db,
    bus: new ChorusBus(),
    api: {
      cleanupTickets: async (projectId: string, input: CleanupTicketsInput) => {
        received = { projectId, input };
        return { deletedTickets: 3, closedPullRequests: 1, removedBranches: 2 };
      },
    } as never,
    config: { dataDir: "/tmp", host: "127.0.0.1", port: 0, maxConcurrentAgents: 1 } as never,
    version: { number: "0.0.0", commit: "test", dirty: false, startedAt: 0 },
  });

  const res = await app.inject({
    method: "POST",
    url: "/api/projects/proj_123/tickets/cleanup",
    payload: { confirmation: TICKET_CLEANUP_CONFIRMATION, removeBranches: true, removePullRequests: false },
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deletedTickets: 3, closedPullRequests: 1, removedBranches: 2 });
  assert.deepEqual(received, {
    projectId: "proj_123",
    input: { confirmation: TICKET_CLEANUP_CONFIRMATION, removeBranches: true, removePullRequests: false },
  });

  await app.close();
  db.close();
});
