import type { ActivityItem } from "../stateMachineModel.js";

const ICON: Record<string, string> = {
  message: "💬",
  command: "▶",
  file_change: "✏️",
  plan: "📋",
  quota_warning: "⚠️",
  log: "·",
  triage: "🧭",
  work: "🔧",
  pr: "🔀",
  close: "✓",
  note: "📝",
};

/**
 * Renders a pre-computed activity log under the diagram. The caller decides the
 * scope: the hub-and-spoke view passes an agent's whole-ticket history, while
 * the DAG view passes a single turn's slice — this component just renders.
 */
export function AgentActivityLog({
  items,
  label,
  editTarget,
  onEdit,
}: {
  /** Time-ordered activity to show (already scoped by the caller). */
  items: ActivityItem[];
  /** Heading subject (agent/step actor); null shows the "click above" prompt. */
  label: string | null;
  /** Role name to edit, or null when this subject isn't an editable role. */
  editTarget: string | null;
  onEdit: (name: string) => void;
}) {
  if (!label) {
    return <p className="sm-log-empty">Click an agent above to see its activity.</p>;
  }
  const visibleItems = items.filter((it) => it.kind !== "reasoning");
  return (
    <div className="sm-log">
      <div className="sm-log-head">
        <strong>Activity: {label}</strong>
        {editTarget && (
          <button type="button" className="linkbtn" onClick={() => onEdit(editTarget)}>
            Edit agent →
          </button>
        )}
      </div>
      {visibleItems.length === 0 ? (
        <p className="sm-log-empty">No activity recorded yet for {label}.</p>
      ) : (
        <ul className="sm-log-list">
          {visibleItems.map((it) => (
            <li
              key={`${it.source}-${it.at}-${it.kind}-${it.text}`}
              className={`sm-log-line src-${it.source}`}
            >
              <span className="ts">{new Date(it.at).toLocaleTimeString()}</span>
              <span className="ico">{ICON[it.kind] ?? "·"}</span>
              <span className="sm-log-text">{it.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
