import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type AgentResult, ChorusBus, ConfigSchema, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { Orchestrator } from "../src/orchestrator.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-usage-")), "test.db"));
}

function project(): Project {
  return {
    id: "proj_usage",
    repoUrl: "https://github.com/acme/widgets",
    localPath: mkdtempSync(join(tmpdir(), "chorus-usage-repo-")),
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
  };
}

function result(usage: AgentResult["usage"]): AgentResult {
  return {
    payload: { status: "success", summary: "done", filesChanged: [], notes: "" },
    exitCode: 0,
    signal: null,
    terminalReason: "completed",
    usage,
    rawLogPath: "/tmp/raw.log",
    outputFilePath: "/tmp/result.json",
  };
}

test("recordUsage persists total-only backend usage", () => {
  const db = freshDb();
  const bus = new ChorusBus();
  const seen: unknown[] = [];
  bus.on((event) => {
    if (event.type === "usage") seen.push(event);
  });
  const orchestrator = new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { id: "test", notify: async () => {} },
    bus,
    config: ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-usage-data-")) }),
  });

  (orchestrator as unknown as {
    recordUsage(runId: string, project: Project, result: AgentResult): void;
  }).recordUsage("run_total", project(), result({ totalTokens: 5 }));

  const [event] = db.recentUsage(1);
  assert.equal(event?.runId, "run_total");
  assert.equal(event?.inputTokens, null);
  assert.equal(event?.outputTokens, null);
  assert.equal(event?.totalTokens, 5);
  assert.deepEqual(db.usageTotals(), { inputTokens: 0, outputTokens: 0, totalTokens: 5 });
  assert.equal(seen.length, 1);
  db.close();
});

test("recordUsage derives totals when backend reports split counts only", () => {
  const db = freshDb();
  const orchestrator = new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { id: "test", notify: async () => {} },
    bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-usage-data-")) }),
  });

  (orchestrator as unknown as {
    recordUsage(runId: string, project: Project, result: AgentResult): void;
  }).recordUsage("run_split", project(), result({ inputTokens: 10, outputTokens: 3 }));

  const [event] = db.recentUsage(1);
  assert.equal(event?.inputTokens, 10);
  assert.equal(event?.outputTokens, 3);
  assert.equal(event?.totalTokens, 13);
  assert.deepEqual(db.usageTotals(), { inputTokens: 10, outputTokens: 3, totalTokens: 13 });
  db.close();
});
