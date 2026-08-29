import type { MouseEvent } from "react";
import type { AgentBox } from "../stateMachineModel.js";

/**
 * Radial hub-and-spoke view: the orchestrator at the center, spoke agents on a
 * ring. Active agents pulse; the selected one is highlighted. Clicking a node
 * selects it (drives the activity log); the ✎ jumps to the agent editor.
 */
export function HubSpokeView({
  agents,
  active,
  selected,
  onSelect,
  onEdit,
}: {
  agents: AgentBox[];
  active: Set<string>;
  selected: string | null;
  onSelect: (name: string) => void;
  onEdit: (name: string) => void;
}) {
  const hub = agents.find((a) => a.isHub) ?? agents[0];
  const spokes = agents.filter((a) => !a.isHub);
  const W = 460;
  const H = 320;
  const cx = W / 2;
  const cy = H / 2;
  const R = 118;
  const pos = (i: number, n: number) => {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    return { x: cx + R * Math.cos(ang), y: cy + R * Math.sin(ang) };
  };

  return (
    <svg className="hubspoke" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Hub and spoke agent view">
      {spokes.map((s, i) => {
        const p = pos(i, spokes.length);
        return <line key={`link-${s.name}`} className="hs-link" x1={cx} y1={cy} x2={p.x} y2={p.y} />;
      })}
      {spokes.map((s, i) => {
        const p = pos(i, spokes.length);
        return (
          <Node
            key={s.name}
            box={s}
            x={p.x}
            y={p.y}
            active={active.has(s.name)}
            selected={selected === s.name}
            onSelect={onSelect}
            onEdit={onEdit}
          />
        );
      })}
      {hub && (
        <Node
          box={hub}
          x={cx}
          y={cy}
          hub
          active={active.has(hub.name)}
          selected={selected === hub.name}
          onSelect={onSelect}
          onEdit={onEdit}
        />
      )}
    </svg>
  );
}

function Node({
  box,
  x,
  y,
  active,
  selected,
  hub,
  onSelect,
  onEdit,
}: {
  box: AgentBox;
  x: number;
  y: number;
  active: boolean;
  selected: boolean;
  hub?: boolean;
  onSelect: (name: string) => void;
  onEdit: (name: string) => void;
}) {
  const w = hub ? 132 : 118;
  const h = 40;
  const cls = `hs-node${hub ? " hub" : ""}${active ? " sm-pulse" : ""}${selected ? " selected" : ""}`;
  const editClick = (e: MouseEvent) => {
    e.stopPropagation();
    onEdit(box.name);
  };
  return (
    <g
      className={cls}
      transform={`translate(${x - w / 2},${y - h / 2})`}
      onClick={() => onSelect(box.name)}
    >
      <rect width={w} height={h} rx={9} />
      <text className="hs-label" x={w / 2} y={h / 2} dominantBaseline="central" textAnchor="middle">
        {trunc(box.name, hub ? 16 : 14)}
      </text>
      {box.editable && (
        <text className="hs-edit" x={w - 13} y={14} onClick={editClick} aria-label={`Edit ${box.name}`}>
          ✎
        </text>
      )}
    </g>
  );
}

function trunc(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
