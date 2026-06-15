import type { Ticket } from "../api.js";

/**
 * Lists the tickets that currently have an open GitHub PR awaiting a manual
 * merge. Replaces the old integration-branch commit log: with the PR flow,
 * "what's waiting for me on GitHub" is the useful at-a-glance view.
 */
export function OpenPrs({ tickets, hasProject }: { tickets: Ticket[]; hasProject: boolean }) {
  if (!hasProject) return <p className="empty">Select a project.</p>;
  const open = tickets.filter((t) => t.prUrl && t.status === "pr_open");
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
