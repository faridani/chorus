import assert from "node:assert/strict";
import { test } from "node:test";
import { ChorusBus, type ChorusEvent } from "../src/index.js";

function agentEvent(kind: "message" | "reasoning", text: string): ChorusEvent {
  return {
    type: "agent_event",
    projectId: "p1",
    taskId: "task-1",
    role: "software-dev",
    ticketId: "t1",
    ticketTitle: "Ticket",
    event: { kind, text, at: 1 },
    at: 2,
  };
}

test("ChorusBus drops reasoning agent events before listeners receive them", () => {
  const bus = new ChorusBus();
  const seen: ChorusEvent[] = [];
  bus.on((event) => seen.push(event));

  bus.emit(agentEvent("reasoning", "internal chain"));
  bus.emit(agentEvent("message", "operational update"));

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.type, "agent_event");
  if (seen[0]?.type === "agent_event") {
    assert.equal(seen[0].event.kind, "message");
    assert.equal(seen[0].event.text, "operational update");
  }
});
