import type { MouseEvent } from "react";
import type { DagNode } from "../stateMachineModel.js";

/**
 * Linear DAG view: the actual run sequence (orchestrator → spoke → orchestrator
 * → …), consecutive same-actor steps collapsed into one node. Every hand-off is
 * its own box, identified by step id (not actor) — so a return to the same actor
 * is a distinct, separately-selectable node. Clicking a node selects that step
 * (drives the per-turn activity log); the ✎ jumps to the agent editor. This view
 * is independent of the hub-and-spoke participant model.
 */
export function DagView({
  nodes,
  activeStepId,
  selectedStepId,
  onSelect,
  onEdit,
}: {
  nodes: DagNode[];
  activeStepId: string | null;
  selectedStepId: string | null;
  onSelect: (stepId: string) => void;
  onEdit: (actor: string) => void;
}) {
  if (nodes.length === 0) {
    return <p className="sm-log-empty">No runs yet — the DAG appears as agents work the ticket.</p>;
  }
  const editClick = (actor: string) => (e: MouseEvent) => {
    e.stopPropagation();
    onEdit(actor);
  };
  return (
    <div className="dagflow">
      {nodes.map((n, i) => (
        <span key={n.id} className="dag-step-wrap">
          <button
            type="button"
            className={`dag-node kind-${n.kind}${activeStepId === n.id ? " sm-pulse" : ""}${
              selectedStepId === n.id ? " selected" : ""
            }`}
            title={n.lastMessage}
            onClick={() => onSelect(n.id)}
          >
            <span className="dag-actor">
              {n.actor}
              {n.count > 1 ? ` ×${n.count}` : ""}
              {n.editable && (
                <span className="dag-edit" onClick={editClick(n.actor)} aria-label={`Edit ${n.actor}`}>
                  {" "}
                  ✎
                </span>
              )}
            </span>
            <span className="dag-msg">{n.lastMessage}</span>
          </button>
          {i < nodes.length - 1 && <span className="sm-arrow">→</span>}
        </span>
      ))}
    </div>
  );
}
