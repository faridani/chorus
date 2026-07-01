import { api, type Suggestion } from "../api.js";

/** Messages the orchestrator wants to communicate to the human. */
export function SuggestionsTab({
  projectId,
  suggestions,
  onChange,
}: {
  projectId: string;
  suggestions: Suggestion[];
  onChange: () => void;
}) {
  if (suggestions.length === 0) {
    return <p className="muted">No suggestions. The orchestrator posts here when it needs your input (e.g. “create a Security agent”).</p>;
  }
  return (
    <ul className="suggestions">
      {suggestions.map((s) => (
        <li key={s.id}>
          {s.title ? (
            <div className="sg-structured">
              <div className="sg-title">{s.title}</div>
              <dl>
                <div>
                  <dt>Area</dt>
                  <dd>{s.affectedArea || "Not specified"}</dd>
                </div>
                <div>
                  <dt>Rationale</dt>
                  <dd>{s.rationale || s.message}</dd>
                </div>
                <div>
                  <dt>Action</dt>
                  <dd>{s.proposedAction || "Review manually"}</dd>
                </div>
                {s.recommendedAgent || s.recommendedTool || s.recommendedSkill ? (
                  <div>
                    <dt>Recommended support</dt>
                    <dd>
                      {[s.recommendedAgent, s.recommendedTool, s.recommendedSkill].filter(Boolean).join(" · ")}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          ) : (
            <div className="sg-text">{s.message}</div>
          )}
          <div className="sg-meta">
            <span className="muted">{new Date(s.createdAt).toLocaleString()}</span>
            <button
              onClick={async () => {
                await api.dismissSuggestion(projectId, s.id);
                onChange();
              }}
            >
              Dismiss
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
