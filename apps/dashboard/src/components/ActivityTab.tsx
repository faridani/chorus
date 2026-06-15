import type { ChangelogEntry, Merge } from "../api.js";

/** Recent merges + changelog for the project. */
export function ActivityTab({ merges, changelog }: { merges: Merge[]; changelog: ChangelogEntry[] }) {
  return (
    <div className="cols">
      <section>
        <h3>Recent merges</h3>
        <ul className="merges">
          {merges.map((m) => (
            <li key={m.id}>
              <span className={`tag status-${m.status}`}>{m.status}</span>{" "}
              {m.mergeCommit ? m.mergeCommit.slice(0, 8) : m.conflictFiles.join(", ")}
              <span className="muted"> {new Date(m.createdAt).toLocaleString()}</span>
            </li>
          ))}
          {merges.length === 0 && <li className="muted">none yet</li>}
        </ul>
      </section>

      <section>
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
    </div>
  );
}
