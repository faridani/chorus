import { useEffect, useMemo, useState } from "react";
import type { Role, Ticket, TicketEvent } from "../api.js";
import {
  activeAgents,
  agentActivity,
  buildDag,
  type FeedItem,
  spokeAgents,
  stepActivity,
} from "../stateMachineModel.js";
import { AgentActivityLog } from "./AgentActivityLog.js";
import { DagView } from "./DagView.js";
import { HubSpokeView } from "./HubSpokeView.js";

/**
 * Per-ticket state-machine visualization. Each active ticket gets a toggle
 * between a hub-and-spoke view (orchestrator + spokes, agents pulse while
 * working) and a DAG view (the run sequence). Clicking an agent shows its
 * activity log below; the ✎ / "Edit agent →" jumps to the Agents tab.
 */
export function StateMachineTab({
  tickets,
  events,
  feed,
  roles,
  runningTaskIds,
  onDebugTicket,
  onEditAgent,
}: {
  tickets: Ticket[];
  events: TicketEvent[];
  feed: FeedItem[];
  roles: Role[];
  runningTaskIds: string[];
  onDebugTicket: (ticketId: string, ticketTitle: string) => void;
  onEditAgent: (roleName: string) => void;
}) {
  // Ticking clock so "active" agents fade out a few seconds after their last event.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 3000);
    return () => clearInterval(t);
  }, []);

  const current = tickets.filter((t) => t.status !== "merged" && t.status !== "closed");
  if (current.length === 0) {
    return <p className="empty">No active tickets. The graph appears as the orchestrator routes work.</p>;
  }

  return (
    <div className="statemachine">
      {current.map((t) => (
        <TicketStateMachine
          key={t.id}
          ticket={t}
          events={events}
          feed={feed}
          roles={roles}
          runningTaskIds={runningTaskIds}
          now={now}
          onDebugTicket={onDebugTicket}
          onEditAgent={onEditAgent}
        />
      ))}
    </div>
  );
}

function TicketStateMachine({
  ticket,
  events,
  feed,
  roles,
  runningTaskIds,
  now,
  onDebugTicket,
  onEditAgent,
}: {
  ticket: Ticket;
  events: TicketEvent[];
  feed: FeedItem[];
  roles: Role[];
  runningTaskIds: string[];
  now: number;
  onDebugTicket: (ticketId: string, ticketTitle: string) => void;
  onEditAgent: (roleName: string) => void;
}) {
  const [view, setView] = useState<"hub" | "dag">("hub");
  // Selection is per-view and uses different keys: the hub-and-spoke view
  // selects an agent by name; the DAG selects a turn by step id. They are
  // intentionally not shared — the two views are different projections.
  const [hubSel, setHubSel] = useState<string | null>(null);
  const [dagSel, setDagSel] = useState<string | null>(null);

  // Memoized so the 3s ticking clock (which only changes `now`) doesn't re-run
  // these filters/sorts over the (potentially large) events/feed arrays.
  const agents = useMemo(() => spokeAgents(roles, events, ticket.id, feed), [roles, events, ticket.id, feed]);
  const editable = useMemo(() => new Set(agents.filter((a) => a.editable).map((a) => a.name)), [agents]);
  const dag = useMemo(
    () => buildDag(events, ticket.id, new Set(roles.map((r) => r.name))),
    [events, ticket.id, roles],
  );
  // Depends on `now`, so recomputed each tick (cheap: a single pass over feed).
  const active = activeAgents(feed, ticket.id, runningTaskIds, now);
  const isWorking = runningTaskIds.includes(ticket.id);

  // Hub: default to the most recent actor. DAG: default to the last (current) step.
  const lastNode = dag[dag.length - 1] ?? null;
  const effectiveHub = hubSel ?? lastNode?.actor ?? null;
  const effectiveStepId = dagSel ?? lastNode?.id ?? null;
  // In the DAG, only the current (last) turn pulses — not every box of that
  // actor. That's the per-step semantics the hub-and-spoke view doesn't have.
  const activeStepId =
    isWorking && lastNode && active.has(lastNode.actor) ? lastNode.id : null;

  // The log content differs by view: the hub shows an agent's whole-ticket
  // history; the DAG shows just the selected turn's slice.
  const { logItems, logLabel, logEditTarget } = useMemo(() => {
    if (view === "dag") {
      const node = dag.find((n) => n.id === effectiveStepId) ?? null;
      return {
        logItems: node ? stepActivity(events, feed, ticket.id, node) : [],
        logLabel: node ? `${node.actor}${node.count > 1 ? ` ×${node.count}` : ""}` : null,
        logEditTarget: node?.editable ? node.actor : null,
      };
    }
    return {
      logItems: effectiveHub ? agentActivity(events, feed, ticket.id, effectiveHub) : [],
      logLabel: effectiveHub,
      logEditTarget: effectiveHub && editable.has(effectiveHub) ? effectiveHub : null,
    };
  }, [view, dag, effectiveStepId, effectiveHub, events, feed, ticket.id, editable]);

  return (
    <div className="sm-ticket">
      <div className="sm-title">
        {ticket.title} <span className={`tag status-${ticket.status}`}>{ticket.status}</span>
        {isWorking && <span className="tag running"> running</span>}
        <span className="sm-toggle">
          <button
            type="button"
            className={`sm-tog ${view === "hub" ? "active" : ""}`}
            onClick={() => setView("hub")}
          >
            Hub &amp; Spoke
          </button>
          <button
            type="button"
            className={`sm-tog ${view === "dag" ? "active" : ""}`}
            onClick={() => setView("dag")}
          >
            DAG
          </button>
        </span>
        <button
          type="button"
          className="debugbtn"
          title="Diagnose this ticket's recent activity"
          onClick={() => onDebugTicket(ticket.id, ticket.title)}
        >
          Debug Traces
        </button>
      </div>

      {view === "hub" ? (
        <HubSpokeView
          agents={agents}
          active={active}
          selected={effectiveHub}
          onSelect={setHubSel}
          onEdit={onEditAgent}
        />
      ) : (
        <DagView
          nodes={dag}
          activeStepId={activeStepId}
          selectedStepId={effectiveStepId}
          onSelect={setDagSel}
          onEdit={onEditAgent}
        />
      )}

      <AgentActivityLog
        items={logItems}
        label={logLabel}
        editTarget={logEditTarget}
        onEdit={onEditAgent}
      />
    </div>
  );
}
