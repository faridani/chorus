import assert from "node:assert/strict";
import { test } from "node:test";
import { DecisionZ } from "@chorus/orchestrator";

test("DecisionZ parses a full assign decision", () => {
  const d = DecisionZ.parse({
    action: "assign",
    assignee: "software-dev",
    priority: 90,
    newTickets: [],
    suggestions: [],
    message: "Needs implementation; assigning to software-dev.",
  });
  assert.equal(d.action, "assign");
  assert.equal(d.assignee, "software-dev");
  assert.equal(d.priority, 90);
});

test("DecisionZ tolerates missing optional fields", () => {
  const d = DecisionZ.parse({ action: "close", message: "Nothing to do." });
  assert.equal(d.action, "close");
  assert.equal(d.assignee, "");
  assert.deepEqual(d.newTickets, []);
  assert.deepEqual(d.suggestions, []);
});

test("DecisionZ captures suggestions + follow-up tickets", () => {
  const d = DecisionZ.parse({
    action: "needs_human",
    message: "Need a security specialist.",
    suggestions: ["Create a Security agent to check for vulnerabilities"],
    newTickets: [{ title: "Audit deps", body: "Run npm audit", priority: 50 }],
  });
  assert.equal(d.suggestions.length, 1);
  assert.equal(d.newTickets[0]?.title, "Audit deps");
});

test("DecisionZ rejects an unknown action", () => {
  assert.equal(DecisionZ.safeParse({ action: "frobnicate", message: "x" }).success, false);
});
