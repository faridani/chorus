import assert from "node:assert/strict";
import { test } from "node:test";
import { extractUsage, mapCodexLine } from "@chorus/backends";

test("non-JSON line becomes a log event", () => {
  const events = mapCodexLine("warning: something noisy");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.kind, "log");
});

test("blank line yields nothing", () => {
  assert.deepEqual(mapCodexLine("   "), []);
});

test("thread.started / turn.started produce no user-facing events", () => {
  assert.deepEqual(mapCodexLine(JSON.stringify({ type: "thread.started", thread_id: "x" })), []);
  assert.deepEqual(mapCodexLine(JSON.stringify({ type: "turn.started" })), []);
});

test("reasoning item maps to a reasoning event", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { id: "i0", type: "reasoning", text: "I will inspect the repo first." },
  });
  const events = mapCodexLine(line);
  assert.equal(events[0]?.kind, "reasoning");
  if (events[0]?.kind === "reasoning") assert.match(events[0].text, /inspect the repo/);
});

test("agent_message: plain text becomes a message", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: { id: "i1", type: "agent_message", text: "Working on the loader now." },
  });
  const events = mapCodexLine(line);
  assert.equal(events[0]?.kind, "message");
});

test("agent_message: JSON result surfaces only the summary", () => {
  const payload = JSON.stringify({ status: "success", summary: "Added the loader.", filesChanged: [], notes: "" });
  const line = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: payload } });
  const events = mapCodexLine(line);
  assert.equal(events[0]?.kind, "message");
  if (events[0]?.kind === "message") assert.equal(events[0].text, "Added the loader.");
});

test("command_execution: started → running; success completion is silent; failure surfaces", () => {
  const start = mapCodexLine(
    JSON.stringify({ type: "item.started", item: { type: "command_execution", command: "pwd" } }),
  );
  assert.equal(start[0]?.kind, "command");
  if (start[0]?.kind === "command") assert.equal(start[0].status, "running");

  // Successful completion emits nothing (avoids doubling the feed).
  const ok = mapCodexLine(
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "pwd", exit_code: 0 } }),
  );
  assert.deepEqual(ok, []);

  // Failed completion surfaces the exit code.
  const bad = mapCodexLine(
    JSON.stringify({ type: "item.completed", item: { type: "command_execution", command: "boom", exit_code: 2 } }),
  );
  assert.equal(bad[0]?.kind, "command");
  if (bad[0]?.kind === "command") {
    assert.equal(bad[0].status, "failed");
    assert.equal(bad[0].exitCode, 2);
  }
});

test("file_change paths are made worktree-relative", () => {
  const line = JSON.stringify({
    type: "item.completed",
    item: {
      type: "file_change",
      changes: [
        { path: "/wt/abc/src/index.ts", kind: "add" },
        { path: "/wt/abc/README.md", kind: "update" },
      ],
    },
  });
  const events = mapCodexLine(line, "/wt/abc");
  assert.equal(events[0]?.kind, "file_change");
  if (events[0]?.kind === "file_change") {
    assert.deepEqual(events[0].files, ["src/index.ts", "README.md"]);
  }
});

test("todo_list maps to a plan event", () => {
  const line = JSON.stringify({
    type: "item.started",
    item: { type: "todo_list", items: [{ text: "a", completed: true }, { text: "b", completed: false }] },
  });
  const events = mapCodexLine(line);
  assert.equal(events[0]?.kind, "plan");
  if (events[0]?.kind === "plan") {
    assert.equal(events[0].items.length, 2);
    assert.equal(events[0].items[0]?.completed, true);
  }
});

test("turn.completed carries usage", () => {
  const line = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
  const events = mapCodexLine(line);
  assert.equal(events[0]?.kind, "usage");
  if (events[0]?.kind === "usage") assert.equal(events[0].usage.totalTokens, 15);
});

test("turn.failed with rate limit raises quota_warning", () => {
  const line = JSON.stringify({ type: "turn.failed", error: { message: "429 rate limit" } });
  const events = mapCodexLine(line);
  assert.ok(events.some((e) => e.kind === "quota_warning"));
});

test("extractUsage: handles alternate spellings (prompt/completion)", () => {
  const u = extractUsage({ deep: { prompt_tokens: 3, completion_tokens: 7 } });
  assert.ok(u);
  assert.equal(u?.inputTokens, 3);
  assert.equal(u?.outputTokens, 7);
});
