import assert from "node:assert/strict";
import { test } from "node:test";
import { getOpenPrTickets } from "../src/components/OpenPrs.js";
import type { PullRequest, Ticket } from "../src/api.js";

function ticket(patch: Partial<Ticket> = {}): Ticket {
  return {
    id: patch.id ?? "tkt_1",
    title: patch.title ?? "Ticket",
    body: patch.body ?? "Body",
    status: patch.status ?? "pr_open",
    roleName: patch.roleName ?? "orchestrator",
    priority: patch.priority ?? 0,
    source: patch.source ?? "manual",
    branch: patch.branch ?? "chorus/ticket",
    worktreePath: patch.worktreePath ?? null,
    prUrl: patch.prUrl ?? "https://github.com/owner/repo/pull/1",
    prNumber: patch.prNumber ?? 1,
    starred: patch.starred ?? false,
    tasks: patch.tasks ?? [],
  };
}

function pullRequest(patch: Partial<PullRequest> = {}): PullRequest {
  return {
    id: patch.id ?? "pr_1",
    ticketId: patch.ticketId ?? "tkt_1",
    url: patch.url ?? "https://github.com/owner/repo/pull/1",
    number: patch.number ?? 1,
    state: patch.state ?? "OPEN",
    createdAt: patch.createdAt ?? Date.now(),
    updatedAt: patch.updatedAt ?? Date.now(),
  };
}

test("getOpenPrTickets hides tickets whose current PR record is terminal", () => {
  const open = ticket({
    id: "tkt_open",
    title: "Still open",
    prNumber: 60,
    prUrl: "https://github.com/owner/repo/pull/60",
  });
  const merged = ticket({
    id: "tkt_merged",
    title: "Merged PR",
    prNumber: 61,
    prUrl: "https://github.com/owner/repo/pull/61",
  });
  const closed = ticket({
    id: "tkt_closed",
    title: "Closed PR",
    prNumber: 41,
    prUrl: "https://github.com/owner/repo/pull/41",
  });

  const visible = getOpenPrTickets(
    [open, merged, closed],
    [
      pullRequest({ id: "pr_open", ticketId: open.id, number: 60, url: open.prUrl, state: "OPEN" }),
      pullRequest({ id: "pr_merged", ticketId: merged.id, number: 61, url: merged.prUrl, state: "MERGED" }),
      pullRequest({ id: "pr_closed", ticketId: closed.id, number: 41, url: closed.prUrl, state: "CLOSED" }),
    ],
  );

  assert.deepEqual(
    visible.map((t) => t.id),
    ["tkt_open"],
  );
});
