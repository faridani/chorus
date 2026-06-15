import type { AttemptJournalEntry, ChangelogEntry, PullRequest } from "../api.js";

/** Recent pull requests, the attempt journal (reflective memory), and changelog. */
export function ActivityTab({
  pullRequests,
  attemptJournal,
  changelog,
}: {
  pullRequests: PullRequest[];
  attemptJournal: AttemptJournalEntry[];
  changelog: ChangelogEntry[];
}) {
  return (
    <div className="cols">
      <section>
        <h3>Pull requests</h3>
        <ul className="prs">
          {pullRequests.map((p) => (
            <li key={p.id}>
              <span className={`tag pr-state-${p.state.toLowerCase()}`}>{p.state}</span>{" "}
              <a href={p.url} target="_blank" rel="noreferrer">
                {p.number ? `#${p.number}` : "PR"}
              </a>
              <span className="muted"> {new Date(p.createdAt).toLocaleString()}</span>
            </li>
          ))}
          {pullRequests.length === 0 && <li className="muted">none yet</li>}
        </ul>

        <h3>Changelog</h3>
        <ul className="changelog">
          {changelog.map((c) => (
            <li key={c.id}>
              <span className="muted">{new Date(c.createdAt).toLocaleString()}</span> — {c.entry}
              {c.agentRole ? ` (${c.agentRole})` : ""}
            </li>
          ))}
          {changelog.length === 0 && <li className="muted">empty</li>}
        </ul>
      </section>

      <section>
        <h3>Attempt journal</h3>
        <ul className="journal">
          {attemptJournal.map((j) => (
            <li key={j.id}>
              <div>
                <span className="tag">attempt {j.attempt}</span>{" "}
                {j.verifyPassed === null ? (
                  <span className="tag">verify n/a</span>
                ) : (
                  <span className={`tag ${j.verifyPassed ? "pr-state-merged" : "status-failed"}`}>
                    verify {j.verifyPassed ? "passed" : "failed"}
                  </span>
                )}{" "}
                <span className="muted">→ {j.nextAction ?? "—"}</span>
                <span className="muted"> · {new Date(j.createdAt).toLocaleString()}</span>
              </div>
              {j.diagnosis && <div className="journal-diag">{j.diagnosis}</div>}
              {j.proof && <div className="muted journal-proof">proof: {j.proof}</div>}
            </li>
          ))}
          {attemptJournal.length === 0 && <li className="muted">no attempts recorded yet</li>}
        </ul>
      </section>
    </div>
  );
}
