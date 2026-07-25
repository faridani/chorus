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
          <div className="sg-text">{s.message}</div>
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
