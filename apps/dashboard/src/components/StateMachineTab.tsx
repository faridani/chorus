import type { Ticket, TicketEvent } from "../api.js";

/**
 * Visualizes each current ticket's journey through the agents as a left-to-right
 * graph: boxes labeled with the agent name, arrows for transitions, and the
 * message / work each agent contributed.
 */
export function StateMachineTab({
  tickets,
  events,
}: {
  tickets: Ticket[];
  events: TicketEvent[];
}) {
  const byTicket = new Map<string, TicketEvent[]>();
  for (const e of events) {
    const arr = byTicket.get(e.ticketId) ?? [];
    arr.push(e);
    byTicket.set(e.ticketId, arr);
  }
  for (const arr of byTicket.values()) arr.sort((a, b) => a.createdAt - b.createdAt);

  // "Current" tickets: not terminal. Show those with any trail first.
  const current = tickets.filter((t) => t.status !== "merged" && t.status !== "closed");

  if (current.length === 0) {
    return <p className="empty">No active tickets. The graph appears as the orchestrator routes work.</p>;
  }

  return (
    <div className="statemachine">
      {current.map((t) => {
        const steps = byTicket.get(t.id) ?? [];
        return (
          <div key={t.id} className="sm-ticket">
            <div className="sm-title">
              {t.title} <span className={`tag status-${t.status}`}>{t.status}</span>
              <span className="muted"> · now with: {t.roleName ?? "—"}</span>
            </div>
            {steps.length === 0 ? (
              <div className="muted sm-empty">Awaiting first action…</div>
            ) : (
              <div className="sm-flow">
                {steps.map((s, i) => (
                  <span key={s.id} className="sm-step-wrap">
                    <span className={`sm-step kind-${s.kind}`} title={s.message}>
                      <span className="sm-actor">{s.actor}</span>
                      <span className="sm-kind">{s.kind}</span>
                      <span className="sm-msg">{s.message}</span>
                    </span>
                    {i < steps.length - 1 && <span className="sm-arrow">→</span>}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
