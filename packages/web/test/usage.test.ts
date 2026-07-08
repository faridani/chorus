import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, ConfigSchema } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { createServer } from "@chorus/web";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-web-usage-")), "test.db"));
}

test("state and usage APIs include aggregate total tokens", async () => {
  const db = freshDb();
  db.insertUsage({
    id: "usage_total_only",
    runId: "run_total_only",
    projectId: "proj_total_only",
    kind: "tokens",
    inputTokens: null,
    outputTokens: null,
    totalTokens: 5,
    detail: null,
    observedAt: Date.now(),
  });
  const app = createServer({
    db,
    bus: new ChorusBus(),
    api: {
      orchestratorState: () => "running",
      runningTaskIds: () => [],
      addressingPrTicketIds: () => [],
      listBackends: () => [],
    } as never,
    config: ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-web-usage-data-")) }),
    version: { number: "0.0.0", commit: "test", dirty: false, startedAt: 0 },
  });

  const state = await app.inject({ method: "GET", url: "/api/state" });
  assert.equal(state.statusCode, 200);
  assert.deepEqual(state.json().usageTotals, { inputTokens: 0, outputTokens: 0, totalTokens: 5 });

  const usage = await app.inject({ method: "GET", url: "/api/usage" });
  assert.equal(usage.statusCode, 200);
  const body = usage.json() as {
    totals: { inputTokens: number; outputTokens: number; totalTokens: number };
    recent: Array<{ inputTokens: number | null; outputTokens: number | null; totalTokens: number | null }>;
  };
  assert.deepEqual(body.totals, { inputTokens: 0, outputTokens: 0, totalTokens: 5 });
  assert.equal(body.recent[0]?.inputTokens, null);
  assert.equal(body.recent[0]?.outputTokens, null);
  assert.equal(body.recent[0]?.totalTokens, 5);

  await app.close();
  db.close();
});
