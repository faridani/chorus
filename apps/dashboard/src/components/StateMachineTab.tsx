import { useState } from "react";
import type { Ticket, TicketEvent } from "../api.js";

/**
 * Visualizes each current ticket's journey through the agents as a left-to-right
 * graph: boxes labeled with the agent name, arrows for transitions, the message
 * each agent contributed (click a box to expand its full text), plus a trailing
 * "current state" node that blinks while an agent is actively working.
 */
export function StateMachineTab({
  tickets,
  events,
  runningTaskIds,
}: {
  tickets: Ticket[];
  events: TicketEvent[];
  runningTaskIds: string[];
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const running = new Set(runningTaskIds);
  const byTicket = new Map<string, TicketEvent[]>();
  for (const e of events) {
    const arr = byTicket.get(e.ticketId) ?? [];
    arr.push(e);
    byTicket.set(e.ticketId, arr);
  }
  for (const arr of byTicket.values()) arr.sort((a, b) => a.createdAt - b.createdAt);

  const current = tickets.filter((t) => t.status !== "merged" && t.status !== "closed");

  if (current.length === 0) {
    return <p className="empty">No active tickets. The graph appears as the orchestrator routes work.</p>;
  }

  return (
    <div className="statemachine">
      {current.map((t) => {
        const steps = byTicket.get(t.id) ?? [];
        const isWorking = running.has(t.id);
        const assignee = t.roleName ?? "—";
        const currentId = `${t.id}:current`;
        return (
          <div key={t.id} className="sm-ticket">
            <div className="sm-title">
              {t.title} <span className={`tag status-${t.status}`}>{t.status}</span>
            </div>
            <div className="sm-flow">
              {steps.map((s) => (
                <span key={s.id} className="sm-step-wrap">
                  <button
                    type="button"
                    className={`sm-step kind-${s.kind} ${expanded.has(s.id) ? "expanded" : ""}`}
                    title={s.message}
                    onClick={() => toggle(s.id)}
                  >
                    <span className="sm-actor">{s.actor}</span>
                    <span className="sm-kind">{s.kind}</span>
                    <span className="sm-msg">{s.message}</span>
                  </button>
                  <span className="sm-arrow">→</span>
                </span>
              ))}

              {/* Current state: where the ticket is right now. */}
              <span className="sm-step-wrap">
                <button
                  type="button"
                  className={`sm-step sm-current ${isWorking ? "sm-blinking" : ""} ${
                    expanded.has(currentId) ? "expanded" : ""
                  }`}
                  title={isWorking ? "An agent is working on this now." : "Waiting / queued."}
                  onClick={() => toggle(currentId)}
                >
                  <span className="sm-actor">{assignee}</span>
                  <span className="sm-kind">{isWorking ? "working…" : "queued"}</span>
                  <span className="sm-msg">
                    {isWorking
                      ? `${assignee} is working on this ticket now.`
                      : `Waiting for ${assignee} (project idle/paused or between turns).`}
                  </span>
                </button>
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
