import { useState } from "react";
import { api, type Role, type Ticket } from "../api.js";

/** Tickets table with a create/edit/delete editor. */
export function TicketsTab({
  projectId,
  tickets,
  roles,
  runningTaskIds,
  onChange,
}: {
  projectId: string;
  tickets: Ticket[];
  roles: Role[];
  runningTaskIds: string[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Ticket | "new" | null>(null);
  const running = new Set(runningTaskIds);
  const isRunning = (t: Ticket) => t.tasks.some((tk) => running.has(tk.id));

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
            <th>Agent</th>
            <th>Priority</th>
            <th>Status</th>
            <th>Latest task</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((t) => {
            const last = t.tasks[t.tasks.length - 1];
            return (
              <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
                <td>{t.title}</td>
                <td>{t.roleName ?? "—"}</td>
                <td>{t.priority}</td>
                <td>
                  <span className={`tag status-${t.status}`}>{t.status}</span>
                  {isRunning(t) && <span className="tag running"> running</span>}
                </td>
                <td>{last ? `${last.state} (a${last.attempt})` : "—"}</td>
              </tr>
            );
          })}
          {tickets.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                no tickets yet
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <TicketEditor
          projectId={projectId}
          roles={roles}
          ticket={editing === "new" ? null : editing}
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
  roles,
  ticket,
  locked,
  onClose,
  onSaved,
}: {
  projectId: string;
  roles: Role[];
  ticket: Ticket | null;
  locked: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(ticket?.title ?? "");
  const [body, setBody] = useState(ticket?.body ?? "");
  const [roleName, setRoleName] = useState(ticket?.roleName ?? roles[0]?.name ?? "software-dev");
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
        {locked && <div className="warn">This ticket's agent is running — editing is disabled.</div>}
        <label>Title</label>
        <input value={title} disabled={locked} onChange={(e) => setTitle(e.target.value)} />
        <label>Description</label>
        <textarea rows={8} value={body} disabled={locked} onChange={(e) => setBody(e.target.value)} />
        <div className="row2">
          <div>
            <label>Agent (role)</label>
            <select value={roleName} disabled={locked} onChange={(e) => setRoleName(e.target.value)}>
              {roles.map((r) => (
                <option key={r.id} value={r.name}>
                  {r.name}
                </option>
              ))}
              {roles.length === 0 && <option value="software-dev">software-dev</option>}
            </select>
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
              >
                Reopen (re-dispatch)
              </button>
            </>
          )}
          <button
            className="primary"
            disabled={busy || locked || !title || !body}
            onClick={() =>
              run(() =>
                ticket
                  ? api.updateTicket(projectId, ticket.id, { title, body, roleName, priority })
                  : api.addTicket(projectId, { title, body, roleName, priority }),
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
