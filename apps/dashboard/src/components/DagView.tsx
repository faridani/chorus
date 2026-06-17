import type { MouseEvent } from "react";
import type { DagNode } from "../stateMachineModel.js";

/**
 * Linear DAG view: the actual run sequence (orchestrator → spoke → orchestrator
 * → …), consecutive same-actor steps collapsed into one node. Clicking a node
 * selects it (drives the activity log); the ✎ jumps to the agent editor.
 */
export function DagView({
  nodes,
  editable,
  active,
  selected,
  onSelect,
  onEdit,
}: {
  nodes: DagNode[];
  editable: Set<string>;
  active: Set<string>;
  selected: string | null;
  onSelect: (name: string) => void;
  onEdit: (name: string) => void;
}) {
  if (nodes.length === 0) {
    return <p className="sm-log-empty">No runs yet — the DAG appears as agents work the ticket.</p>;
  }
  const editClick = (name: string) => (e: MouseEvent) => {
    e.stopPropagation();
    onEdit(name);
  };
  return (
    <div className="dagflow">
      {nodes.map((n, i) => (
        <span key={`${n.actor}-${i}`} className="dag-step-wrap">
          <button
            type="button"
            className={`dag-node kind-${n.kind}${active.has(n.actor) ? " sm-pulse" : ""}${
              selected === n.actor ? " selected" : ""
            }`}
            title={n.lastMessage}
            onClick={() => onSelect(n.actor)}
          >
            <span className="dag-actor">
              {n.actor}
              {n.count > 1 ? ` ×${n.count}` : ""}
              {editable.has(n.actor) && (
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
