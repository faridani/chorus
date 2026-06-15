import type { CommitLogEntry } from "../api.js";

/**
 * Compact git log of the selected project's integration branch — the branch
 * all agent work merges into before the human approves promotion to main.
 */
export function IntegrationLog({
  branch,
  commits,
  hasProject,
}: {
  branch: string | null;
  commits: CommitLogEntry[];
  hasProject: boolean;
}) {
  if (!hasProject) {
    return <p className="muted small">Select a project to see its integration-branch commits.</p>;
  }
  if (commits.length === 0) {
    return <p className="muted small">No commits on {branch ?? "the integration branch"} yet.</p>;
  }
  return (
    <ul className="gitlog">
      {commits.map((c) => (
        <li key={c.hash} title={`${c.subject}\n${c.author} · ${c.relativeDate}`}>
          <code className="sha">{c.shortHash}</code>
          <span className="gsubject">{c.subject}</span>
          <span className="gmeta">
            {c.author} · {c.relativeDate}
          </span>
        </li>
      ))}
    </ul>
  );
}
