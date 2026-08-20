import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { ClaudeBackend, CodexQuotaPolicy, GeminiBackend } from "@chorus/backends";
import type { AgentEvent } from "@chorus/core";

const policy = new CodexQuotaPolicy({
  exhaustionPatterns: ["rate.?limit", "quota", "\\b429\\b"],
  backoffStartMs: 1000,
  backoffMaxMs: 60_000,
});

test("Claude backend launches the selected model and parses structured_output", async (t) => {
  const fixture = fakeCli(t, "claude");
  const backend = new ClaudeBackend({ quotaPolicy: policy, bin: fixture.bin });

  const handle = backend.startRun({
    taskId: "task-1",
    prompt: "do claude work",
    worktreePath: fixture.worktree,
    model: "sonnet",
    artifactsDir: fixture.artifacts,
  });
  const eventsPromise = collect(handle.events);
  const result = await handle.result;
  const events = await eventsPromise;

  assert.equal(result.payload?.status, "success");
  assert.equal(result.payload?.summary, "claude finished");
  assert.deepEqual(result.payload?.filesChanged, ["src/claude.ts"]);
  assert.equal(result.terminalReason, "completed");
  assert.equal(result.usage.totalTokens, 15);
  assert.ok(events.some((e) => e.kind === "message" && e.text === "claude finished"));

  const argv = fixture.argv();
  assert.equal(argv[argv.indexOf("-p") + 1], "do claude work");
  assert.equal(argv[argv.indexOf("--model") + 1], "sonnet");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "bypassPermissions");
  assert.ok(argv.includes("--json-schema"));
});

test("Gemini backend launches the selected model and parses JSON response payload", async (t) => {
  const fixture = fakeCli(t, "gemini");
  const backend = new GeminiBackend({ quotaPolicy: policy, bin: fixture.bin });

  const handle = backend.startRun({
    taskId: "task-2",
    prompt: "do gemini work",
    worktreePath: fixture.worktree,
    model: "gemini-2.5-pro",
    artifactsDir: fixture.artifacts,
  });
  const eventsPromise = collect(handle.events);
  const result = await handle.result;
  const events = await eventsPromise;

  assert.equal(result.payload?.status, "success");
  assert.equal(result.payload?.summary, "gemini finished");
  assert.deepEqual(result.payload?.filesChanged, ["src/gemini.ts"]);
  assert.equal(result.usage.totalTokens, 15);
  assert.ok(events.some((e) => e.kind === "message" && e.text === "gemini finished"));

  const argv = fixture.argv();
  assert.match(argv[argv.indexOf("-p") + 1] ?? "", /do gemini work/);
  assert.match(argv[argv.indexOf("-p") + 1] ?? "", /Chorus final result/);
  assert.equal(argv[argv.indexOf("-m") + 1], "gemini-2.5-pro");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "json");
  assert.equal(argv[argv.indexOf("--approval-mode") + 1], "yolo");
});

function fakeCli(t: TestContext, kind: "claude" | "gemini") {
  const root = mkdtempSync(join(tmpdir(), `chorus-${kind}-backend-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const capture = join(root, "argv.json");
  const bin = join(root, kind);
  const worktree = join(root, "worktree");
  const artifacts = join(root, "artifacts");
  mkdirSync(worktree);
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const kind = ${JSON.stringify(kind)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify(args));
const payload = { status: "success", summary: kind + " finished", filesChanged: ["src/" + kind + ".ts"], notes: "" };
if (kind === "claude") {
  console.log(JSON.stringify({ structured_output: payload, usage: { input_tokens: 10, output_tokens: 5 } }));
} else {
  console.log(JSON.stringify({
    response: JSON.stringify(payload),
    stats: { models: { "gemini-2.5-pro": { tokens: { prompt: 10, candidates: 5, total: 15 } } } }
  }));
}
`,
    "utf8",
  );
  chmodSync(bin, 0o755);
  return {
    bin,
    worktree,
    artifacts,
    argv: () => JSON.parse(readFileSync(capture, "utf8")) as string[],
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}
