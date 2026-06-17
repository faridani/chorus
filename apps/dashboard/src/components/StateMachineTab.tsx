import { useEffect, useMemo, useState } from "react";
import type { Role, Ticket, TicketEvent } from "../api.js";
import {
  activeAgents,
  buildDag,
  type FeedItem,
  spokeAgents,
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
  const [selected, setSelected] = useState<string | null>(null);

  // Memoized so the 3s ticking clock (which only changes `now`) doesn't re-run
  // these filters/sorts over the (potentially large) events/feed arrays.
  const agents = useMemo(() => spokeAgents(roles, events, ticket.id, feed), [roles, events, ticket.id, feed]);
  const editable = useMemo(() => new Set(agents.filter((a) => a.editable).map((a) => a.name)), [agents]);
  const dag = useMemo(() => buildDag(events, ticket.id), [events, ticket.id]);
  // Depends on `now`, so recomputed each tick (cheap: a single pass over feed).
  const active = activeAgents(feed, ticket.id, runningTaskIds, now);
  const isWorking = runningTaskIds.includes(ticket.id);

  // Default the log to the most recent actor so it's useful before any click.
  const effectiveSelected = selected ?? dag[dag.length - 1]?.actor ?? null;

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
          selected={effectiveSelected}
          onSelect={setSelected}
          onEdit={onEditAgent}
        />
      ) : (
        <DagView
          nodes={dag}
          editable={editable}
          active={active}
          selected={effectiveSelected}
          onSelect={setSelected}
          onEdit={onEditAgent}
        />
      )}

      <AgentActivityLog
        events={events}
        feed={feed}
        ticketId={ticket.id}
        agent={effectiveSelected}
        editable={!!effectiveSelected && editable.has(effectiveSelected)}
        onEdit={onEditAgent}
      />
    </div>
  );
}
