import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ticket } from "../src/api.js";
import {
  TICKET_CLEANUP_CONFIRM_TEXT,
  canConfirmTicketCleanup,
  summarizeTicketCleanupTargets,
} from "../src/ticketCleanup.js";

function ticket(patch: Partial<Ticket> = {}): Ticket {
  return {
    id: patch.id ?? "tkt_1",
    title: patch.title ?? "Ticket",
    body: patch.body ?? "Body",
    status: patch.status ?? "open",
    roleName: patch.roleName ?? "orchestrator",
    priority: patch.priority ?? 0,
    source: patch.source ?? "manual",
    branch: patch.branch ?? null,
    worktreePath: patch.worktreePath ?? null,
    prUrl: patch.prUrl ?? null,
    prNumber: patch.prNumber ?? null,
    starred: patch.starred ?? false,
    tasks: patch.tasks ?? [],
  };
}

test("canConfirmTicketCleanup requires exact DELETE and at least one ticket", () => {
  assert.equal(canConfirmTicketCleanup(TICKET_CLEANUP_CONFIRM_TEXT, 1), true);
  assert.equal(canConfirmTicketCleanup("delete", 1), false);
  assert.equal(canConfirmTicketCleanup("DELETE ", 1), false);
  assert.equal(canConfirmTicketCleanup(TICKET_CLEANUP_CONFIRM_TEXT, 0), false);
  assert.equal(canConfirmTicketCleanup(TICKET_CLEANUP_CONFIRM_TEXT, 1, true), false);
});

test("summarizeTicketCleanupTargets counts worked ticket branches and PRs", () => {
  const summary = summarizeTicketCleanupTargets([
    ticket({ branch: "chorus/ticket-one", prUrl: "https://github.com/o/r/pull/1" }),
    ticket({
      id: "tkt_2",
      tasks: [
        {
          id: "task_1",
          state: "merged",
          branch: "chorus/scratch-two",
          attempt: 1,
          startedAt: null,
          endedAt: null,
        },
      ],
    }),
    ticket({ id: "tkt_3" }),
  ]);

  assert.deepEqual(summary, { tickets: 3, branchTickets: 2, pullRequestTickets: 1 });
});
