import { useState } from "react";
import { api, type Ticket, type TicketEvent } from "../api.js";

/** Tickets table with a create/edit/delete editor + activity trail. */
export function TicketsTab({
  projectId,
  tickets,
  events,
  runningTaskIds,
  onChange,
}: {
  projectId: string;
  tickets: Ticket[];
  events: TicketEvent[];
  runningTaskIds: string[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Ticket | "new" | null>(null);
  const running = new Set(runningTaskIds); // ticket ids currently being acted on
  const isRunning = (t: Ticket) => running.has(t.id);

  return (
    <div>
      <div className="tabhead">
        <h3>Tickets ({tickets.length})</h3>
        <button className="primary" onClick={() => setEditing("new")}>
          + New ticket
        </button>
      </div>
      <table className="tickets">
        <thead>
          <tr>
            <th>Title</th>
            <th>Now with</th>
            <th>Priority</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => (
            <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
              <td>{t.title}</td>
              <td>{t.roleName ?? "—"}</td>
              <td>{t.priority}</td>
              <td>
                <span className={`tag status-${t.status}`}>{t.status}</span>
                {isRunning(t) && <span className="tag running"> running</span>}
              </td>
            </tr>
          ))}
          {tickets.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                no tickets yet
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <TicketEditor
          projectId={projectId}
          ticket={editing === "new" ? null : editing}
          trail={
            editing === "new" ? [] : events.filter((e) => e.ticketId === editing.id)
          }
          locked={editing !== "new" && isRunning(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function TicketEditor({
  projectId,
  ticket,
  trail,
  locked,
  onClose,
  onSaved,
}: {
  projectId: string;
  ticket: Ticket | null;
  trail: TicketEvent[];
  locked: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [body, setBody] = useState(ticket?.body ?? "");
  const [priority, setPriority] = useState(ticket?.priority ?? 0);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onSaved();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{ticket ? "Edit ticket" : "New ticket"}</h3>
        {locked && <div className="warn">An agent is working this ticket — editing is disabled.</div>}
        <label>Title</label>
        <input value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
        <label>Description</label>
        <textarea rows={6} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} />
        <div className="row2">
          <div>
            <label>Currently with</label>
            <div className="ro">{ticket ? ticket.roleName ?? "—" : "orchestrator (on create)"}</div>
          </div>
          <div>
            <label>Priority</label>
            <input
              type="number"
              value={priority}
              disabled={locked}
              onChange={(e) => setPriority(Number(e.target.value))}
            />
          </div>
        </div>
        <div className="hint">
          Every ticket is triaged by the orchestrator agent, which assigns it to a worker, merges
          its work, or closes it. Assignment is managed automatically.
        </div>

        {ticket && (
          <>
            <label style={{ marginTop: 12 }}>Activity trail</label>
            <ul className="trail">
              {trail.length === 0 && <li className="muted">No activity yet.</li>}
              {trail.map((e) => (
                <li key={e.id}>
                  <span className="muted">{new Date(e.createdAt).toLocaleString()}</span>{" "}
                  <strong>{e.actor}</strong> <span className={`tag te-${e.kind}`}>{e.kind}</span>{" "}
                  {e.message}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          {ticket && (
            <>
              <button
                className="danger"
                disabled={busy || locked}
                onClick={() => {
                  if (confirm("Delete this ticket?")) void run(() => api.deleteTicket(projectId, ticket.id));
                }}
              >
                Delete
              </button>
              <button
                disabled={busy || locked}
                onClick={() => run(() => api.updateTicket(projectId, ticket.id, { reopen: true }))}
                title="Send this ticket back to the orchestrator to re-triage."
              >
                Reopen
              </button>
            </>
          )}
          <button
            className="primary"
            disabled={busy || locked || !title || !body}
            onClick={() =>
              run(() =>
                ticket
                  ? api.updateTicket(projectId, ticket.id, { title, body, priority })
                  : api.addTicket(projectId, { title, body, priority }),
              )
            }
          >
            {ticket ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
