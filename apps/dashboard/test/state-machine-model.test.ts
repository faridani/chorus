import assert from "node:assert/strict";
import { test } from "node:test";
import type { Role, TicketEvent } from "../src/api.ts";
import { activeAgents, agentActivity, buildDag, type FeedItem, spokeAgents, stepActivity } from "../src/stateMachineModel.ts";

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

test("buildDag gives each hand-off its own step id and time window (a return to an actor is a new step)", () => {
  const events: TicketEvent[] = [
    ev("orchestrator", "triage", "starting", 1),
    ev("orchestrator", "triage", "delegating", 2),
    ev("software-dev", "work", "patched tools.ts", 3),
    ev("orchestrator", "triage", "opening pr", 4),
  ];
  const dag = buildDag(events, "t1", new Set(["software-dev"]));
  // Step ids are unique and positional, not the actor name — the two
  // orchestrator turns are distinct, separately-addressable steps.
  assert.deepEqual(dag.map((n) => n.id), ["0", "1", "2"]);
  assert.equal(new Set(dag.map((n) => n.id)).size, 3);
  assert.equal(dag[0]?.actor, "orchestrator");
  assert.equal(dag[2]?.actor, "orchestrator");
  assert.notEqual(dag[0]?.id, dag[2]?.id);
  // Activity window is [prev.lastAt, next.firstAt): it opens at the prior
  // hand-off (so a turn's pre-summary live stream is captured) and closes at the
  // next step; the first opens at -Infinity and the last stays open.
  assert.equal(dag[0]?.firstAt, 1);
  assert.equal(dag[0]?.startAt, Number.NEGATIVE_INFINITY);
  assert.equal(dag[0]?.endAt, 3);
  assert.equal(dag[1]?.startAt, 2); // orchestrator step 0's lastAt
  assert.equal(dag[1]?.endAt, 4);
  assert.equal(dag[2]?.startAt, 3); // dev step 1's lastAt
  assert.equal(dag[2]?.endAt, Number.POSITIVE_INFINITY);
  // editable derives from roleNames, not the hub/spoke set.
  assert.equal(dag[1]?.editable, true, "software-dev maps to a role");
  assert.equal(dag[0]?.editable, false, "orchestrator not in the provided role set");
});

test("stepActivity scopes to one turn — two orchestrator steps show different logs", () => {
  const events: TicketEvent[] = [
    ev("orchestrator", "triage", "starting", 1),
    ev("orchestrator", "triage", "delegating", 2),
    ev("software-dev", "work", "patched tools.ts", 3),
    ev("orchestrator", "triage", "opening pr", 4),
  ];
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "orchestrator", at: 1, event: { kind: "message", text: "thinking" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "orchestrator", at: 4, event: { kind: "message", text: "done" } } },
  ];
  const dag = buildDag(events, "t1");
  const first = stepActivity(events, feed, "t1", dag[0]!);
  const last = stepActivity(events, feed, "t1", dag[2]!);
  // First orchestrator turn: its trail entries + the live event in [1,3).
  assert.deepEqual(first.map((i) => i.text).sort(), ["delegating", "starting", "thinking"].sort());
  // Third step (orchestrator again): only its own slice, not the first turn's.
  assert.deepEqual(last.map((i) => i.text).sort(), ["done", "opening pr"].sort());
  assert.ok(!last.some((i) => i.text === "starting"), "second turn excludes the first turn's events");
});

test("stepActivity includes public live events before the trail summary and drops reasoning", () => {
  // Worker live events stream during the run; the "work" trail entry is written
  // afterwards (later timestamp). Scoping a step from its trail entry would drop
  // the stream — the window must open at the prior hand-off instead.
  const events: TicketEvent[] = [
    ev("orchestrator", "triage", "delegating", 1),
    ev("software-dev", "work", "committed fix", 5),
  ];
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: 2, event: { kind: "command", command: "npm test" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: 3, event: { kind: "reasoning", text: "patching" } } },
  ];
  const dag = buildDag(events, "t1");
  const devStep = dag.find((n) => n.actor === "software-dev")!;
  const log = stepActivity(events, feed, "t1", devStep);
  assert.deepEqual(
    log.map((i) => i.text),
    ["npm test", "committed fix"],
    "pre-summary commands appear ahead of the trail summary, while reasoning is hidden",
  );
});

test("activeAgents lights only running tickets with a recent live event", () => {
  const now = 100_000;
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "orchestrator", at: now - 1000, event: { kind: "message" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: now - 2000, event: { kind: "command" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "reason-only", at: now - 1000, event: { kind: "reasoning" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "old-agent", at: now - 60_000, event: { kind: "message" } } },
    { e: { type: "agent_event", ticketId: "t2", role: "other", at: now, event: { kind: "message" } } },
  ];
  // Parallel agents both light when the ticket is running and events are fresh.
  const lit = activeAgents(feed, "t1", ["t1"], now);
  assert.deepEqual([...lit].sort(), ["orchestrator", "software-dev"]);
  assert.ok(!lit.has("reason-only"), "reasoning-only live events do not light an agent");
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
  // A gate agent (evaluator) that only shows up in the live feed must still get
  // a node, marked non-editable.
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "evaluator", at: 3, event: { kind: "command" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "reason-only", at: 4, event: { kind: "reasoning" } } },
  ];
  const boxes = spokeAgents(roles, events, "t1", feed);
  assert.equal(boxes[0]?.name, "orchestrator");
  assert.ok(boxes[0]?.isHub);
  const dev = boxes.find((b) => b.name === "software-dev");
  const rev = boxes.find((b) => b.name === "reviewer");
  const evl = boxes.find((b) => b.name === "evaluator");
  const reasonOnly = boxes.find((b) => b.name === "reason-only");
  assert.equal(dev?.editable, true);
  assert.equal(rev?.editable, false, "trail-only actor (reviewer) is not editable");
  assert.equal(evl?.editable, false, "live-feed-only actor (evaluator) appears, non-editable");
  assert.equal(reasonOnly, undefined, "reasoning-only live-feed actors are hidden");
});

test("agentActivity merges trail + public live events for one agent, time-ordered", () => {
  const events: TicketEvent[] = [ev("software-dev", "work", "committed", 5)];
  const feed: FeedItem[] = [
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: 3, event: { kind: "command", command: "npm test" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "software-dev", at: 4, event: { kind: "reasoning", text: "private chain" } } },
    { e: { type: "agent_event", ticketId: "t1", role: "orchestrator", at: 4, event: { kind: "message", text: "nope" } } },
  ];
  const log = agentActivity(events, feed, "t1", "software-dev");
  assert.deepEqual(log.map((i) => i.text), ["npm test", "committed"]);
  assert.deepEqual(log.map((i) => i.source), ["live", "trail"]);
});
