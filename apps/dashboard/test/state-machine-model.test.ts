import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role, TicketEvent } from "../src/api.ts";
import { activeAgents, agentActivity, buildDag, type FeedItem, spokeAgents } from "../src/stateMachineModel.ts";

function ev(actor: string, kind: TicketEvent["kind"], message: string, createdAt: number, ticketId = "t1"): TicketEvent {
  return { id: `${actor}-${createdAt}`, projectId: "p1", ticketId, actor, kind, message, createdAt };
}

test("buildDag collapses consecutive same-actor steps and keeps order", () => {
  const events: TicketEvent[] = [
    ev("orchestrator", "triage", "starting", 1),
    ev("orchestrator", "triage", "delegating", 2),
    ev("software-dev", "work", "patched tools.ts", 3),
    ev("orchestrator", "triage", "opening pr", 4),
    ev("system", "note", "ignored", 5),
  ];
  const dag = buildDag(events, "t1");
  assert.deepEqual(dag.map((n) => n.actor), ["orchestrator", "software-dev", "orchestrator"]);
  assert.equal(dag[0]?.count, 2);
  assert.equal(dag[0]?.lastMessage, "delegating");
  assert.equal(dag[1]?.lastMessage, "patched tools.ts");
});

test("activeAgents lights only running tickets with a recent live event", () => {
  const now = 100_000;
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "orchestrator", at: now - 1000, event: { kind: "message" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: now - 2000, event: { kind: "command" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "old-agent", at: now - 60_000, event: { kind: "message" } } },
    { e: { type: "agent_event", ticketId: "t2", role: "other", at: now, event: { kind: "message" } } },
  ];
  // Parallel agents both light when the ticket is running and events are fresh.
  const lit = activeAgents(feed, "t1", ["t1"], now);
  assert.deepEqual([...lit].sort(), ["orchestrator", "software-dev"]);
  // Stale event (>window) is dropped.
  assert.ok(!lit.has("old-agent"));
  // Ticket not in runningTaskIds → nothing lit.
  assert.equal(activeAgents(feed, "t1", [], now).size, 0);
});

test("spokeAgents marks project roles editable, trail-only actors not, hub first", () => {
  const roles: Role[] = [
    { id: "1", name: "orchestrator", description: "", allowed: [], forbidden: [], allowedToolIds: [], forbiddenToolIds: [], backendId: "codex" },
    { id: "2", name: "software-dev", description: "", allowed: [], forbidden: [], allowedToolIds: [], forbiddenToolIds: [], backendId: "codex" },
  ];
  const events: TicketEvent[] = [ev("software-dev", "work", "x", 1), ev("reviewer", "note", "y", 2)];
  const boxes = spokeAgents(roles, events, "t1");
  assert.equal(boxes[0]?.name, "orchestrator");
  assert.ok(boxes[0]?.isHub);
  const dev = boxes.find((b) => b.name === "software-dev");
  const rev = boxes.find((b) => b.name === "reviewer");
  assert.equal(dev?.editable, true);
  assert.equal(rev?.editable, false, "trail-only actor (reviewer) is not editable");
});

test("agentActivity merges trail + live for one agent, time-ordered", () => {
  const events: TicketEvent[] = [ev("software-dev", "work", "committed", 5)];
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: 3, event: { kind: "command", command: "npm test" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "orchestrator", at: 4, event: { kind: "message", text: "nope" } } },
  ];
  const log = agentActivity(events, feed, "t1", "software-dev");
  assert.deepEqual(log.map((i) => i.text), ["npm test", "committed"]);
  assert.deepEqual(log.map((i) => i.source), ["live", "trail"]);
});
