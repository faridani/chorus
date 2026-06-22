import type { PullRequest, Ticket } from "../api.js";

/**
 * Lists the tickets that currently have an open GitHub PR awaiting a manual
 * merge. Replaces the old integration-branch commit log: with the PR flow,
 * "what's waiting for me on GitHub" is the useful at-a-glance view.
 */
export function OpenPrs({
  tickets,
  pullRequests,
  hasProject,
}: {
  tickets: Ticket[];
  pullRequests: PullRequest[];
  hasProject: boolean;
}) {
  if (!hasProject) return <p className="empty">Select a project.</p>;
  const open = getOpenPrTickets(tickets, pullRequests);
  if (open.length === 0) return <p className="empty">No open PRs.</p>;
  return (
    <ul className="pr-list">
      {open.map((t) => (
        <li key={t.id} className="pr-item">
          <a href={t.prUrl ?? undefined} target="_blank" rel="noreferrer" className="pr-link">
            {t.prNumber ? `#${t.prNumber}` : "PR"} — {t.title}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function getOpenPrTickets(tickets: Ticket[], pullRequests: PullRequest[]): Ticket[] {
  return tickets.filter((t) => t.prUrl && t.status === "pr_open" && isCurrentPullRequestOpen(t, pullRequests));
}

function isCurrentPullRequestOpen(ticket: Ticket, pullRequests: PullRequest[]): boolean {
  const current = pullRequests.filter(
    (p) =>
      p.ticketId === ticket.id &&
      ((ticket.prNumber != null && p.number === ticket.prNumber) || (ticket.prUrl != null && p.url === ticket.prUrl)),
  );
  if (current.some((p) => p.state !== "OPEN")) return false;
  return true;
}
