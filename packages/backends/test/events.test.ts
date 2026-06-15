import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage, mapCodexLine } from "@chorus/backends";

test("mapCodexLine: non-JSON line becomes a log event", () => {
  const events = mapCodexLine("warning: something noisy");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "log");
});

test("mapCodexLine: blank line yields nothing", () => {
  assert.deepEqual(mapCodexLine("   "), []);
});

test("mapCodexLine: message becomes progress", () => {
  const events = mapCodexLine(JSON.stringify({ type: "agent_message", message: "working on it" }));
  assert.ok(events.some((e) => e.kind === "progress"));
});

test("mapCodexLine: tool-ish type becomes tool_use", () => {
  const events = mapCodexLine(JSON.stringify({ type: "exec_command", message: "ls" }));
  assert.ok(events.some((e) => e.kind === "tool_use"));
});

test("mapCodexLine: extracts usage from nested token fields", () => {
  const events = mapCodexLine(
    JSON.stringify({ type: "token_count", usage: { input_tokens: 10, output_tokens: 5 } }),
  );
  const usage = events.find((e) => e.kind === "usage");
  assert.ok(usage);
  if (usage?.kind === "usage") {
    assert.equal(usage.usage.inputTokens, 10);
    assert.equal(usage.usage.outputTokens, 5);
    assert.equal(usage.usage.totalTokens, 15);
  }
});

test("extractUsage: handles alternate spellings (prompt/completion)", () => {
  const u = extractUsage({ deep: { prompt_tokens: 3, completion_tokens: 7 } });
  assert.ok(u);
  assert.equal(u?.inputTokens, 3);
  assert.equal(u?.outputTokens, 7);
});

test("mapCodexLine: quota-ish type raises a quota_warning", () => {
  const events = mapCodexLine(JSON.stringify({ type: "rate_limit", message: "slow down" }));
  assert.ok(events.some((e) => e.kind === "quota_warning"));
});
