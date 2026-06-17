import type { TicketEvent } from "../api.js";
import { agentActivity, type FeedItem } from "../stateMachineModel.js";

const ICON: Record<string, string> = {
  reasoning: "💭",
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

/** The activity log under the diagram, scoped to the selected agent. */
export function AgentActivityLog({
  events,
  feed,
  ticketId,
  agent,
  editable,
  onEdit,
}: {
  events: TicketEvent[];
  feed: FeedItem[];
  ticketId: string;
  agent: string | null;
  editable: boolean;
  onEdit: (name: string) => void;
}) {
  if (!agent) {
    return <p className="sm-log-empty">Click an agent above to see its activity.</p>;
  }
  const items = agentActivity(events, feed, ticketId, agent);
  return (
    <div className="sm-log">
      <div className="sm-log-head">
        <strong>Activity: {agent}</strong>
        {editable && (
          <button type="button" className="linkbtn" onClick={() => onEdit(agent)}>
            Edit agent →
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <p className="sm-log-empty">No activity recorded yet for {agent}.</p>
      ) : (
        <ul className="sm-log-list">
          {items.map((it, i) => (
            <li key={i} className={`sm-log-line src-${it.source}`}>
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
