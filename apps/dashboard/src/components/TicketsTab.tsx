import { useEffect, useRef, useState } from "react";
import { api, type Ticket, type TicketEvent } from "../api.js";

/** Tickets table with a create/edit/delete editor + activity trail. */
export function TicketsTab({
  projectId,
  tickets,
  events,
  runningTaskIds,
  idleIdeation,
  idleIdeationCount,
  onChange,
}: {
  projectId: string;
  tickets: Ticket[];
  events: TicketEvent[];
  runningTaskIds: string[];
  idleIdeation: boolean;
  idleIdeationCount: number;
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Ticket | "new" | null>(null);
  const running = new Set(runningTaskIds); // ticket ids currently being acted on
  const isRunning = (t: Ticket) => running.has(t.id);

  // Idle-ideation control: optimistic local state, persisted on change.
  const [ideateOn, setIdeateOn] = useState(idleIdeation);
  const [ideateN, setIdeateN] = useState(String(idleIdeationCount));
  useEffect(() => setIdeateOn(idleIdeation), [idleIdeation]);
  useEffect(() => setIdeateN(String(idleIdeationCount)), [idleIdeationCount]);
  const clampN = (v: string) => Math.min(10, Math.max(1, Math.floor(Number(v)) || 1));
  const saveIdeation = (patch: { idleIdeation?: boolean; idleIdeationCount?: number }) =>
    void api.updateProject(projectId, patch).then(onChange).catch((err) => alert(String(err)));
  const toggleIdeate = () => {
    const next = !ideateOn;
    setIdeateOn(next);
    saveIdeation({ idleIdeation: next });
  };
  const commitN = () => {
    const n = clampN(ideateN);
    setIdeateN(String(n));
    if (n !== idleIdeationCount) saveIdeation({ idleIdeationCount: n });
  };

  // Local order so drag-and-drop feels instant; re-synced when the prop changes.
  const [order, setOrder] = useState<Ticket[]>(tickets);
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  useEffect(() => setOrder(tickets), [tickets]);

  const reorder = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const next = [...order];
    const from = next.findIndex((t) => t.id === fromId);
    const to = next.findIndex((t) => t.id === toId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setOrder(next);
    void api.reorderTickets(projectId, next.map((t) => t.id)).then(onChange).catch((err) => {
      alert(String(err));
      setOrder(tickets); // revert on failure
    });
  };

  return (
    <div>
      <div className="tabhead">
        <h3>Tickets ({tickets.length})</h3>
        <div className="tabhead-actions">
          <div className="ideate-ctl" title="When the queue is empty, automatically generate this many follow-up tickets.">
            <button
              type="button"
              role="switch"
              aria-checked={ideateOn}
              className={`switch ${ideateOn ? "on" : ""}`}
              onClick={toggleIdeate}
            >
              <span className="switch-knob" />
            </button>
            <span className="ideate-label">
              automatically ideate and create
              <input
                type="number"
                min={1}
                max={10}
                className="ideate-n"
                value={ideateN}
                disabled={!ideateOn}
                onChange={(e) => setIdeateN(e.target.value)}
                onBlur={commitN}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              />
              tickets when idle
            </span>
          </div>
          <button className="primary" onClick={() => setEditing("new")}>
            + New ticket
          </button>
        </div>
      </div>
      <table className="tickets">
        <thead>
          <tr>
            <th aria-label="reorder" />
            <th aria-label="star" />
            <th>Title</th>
            <th>Now with</th>
            <th>Priority</th>
            <th>Status</th>
            <th>PR</th>
          </tr>
        </thead>
        <tbody>
          {order.map((t) => (
            <tr
              key={t.id}
              className={`clickable ${dragId === t.id ? "dragging" : ""} ${overId === t.id ? "dragover" : ""}`}
              onClick={() => setEditing(t)}
              onDragOver={(e) => {
                if (!dragIdRef.current) return;
                e.preventDefault();
                if (overId !== t.id) setOverId(t.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const from = dragIdRef.current;
                dragIdRef.current = null;
                setDragId(null);
                setOverId(null);
                if (from) reorder(from, t.id);
              }}
            >
              <td
                className="drag-handle"
                draggable
                title="Drag to reorder — higher in the list means higher priority (dispatched first)."
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => {
                  dragIdRef.current = t.id;
                  setDragId(t.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragEnd={() => {
                  dragIdRef.current = null;
                  setDragId(null);
                  setOverId(null);
                }}
              >
                ⠿
              </td>
              <td className="star-cell" onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className={`star-btn ${t.starred ? "on" : ""}`}
                  aria-pressed={t.starred}
                  title={t.starred ? "Starred — click to unstar" : "Click to star"}
                  onClick={() =>
                    void api
                      .setTicketStarred(projectId, t.id, !t.starred)
                      .then(onChange)
                      .catch((err) => alert(String(err)))
                  }
                >
                  {t.starred ? "★" : "☆"}
                </button>
              </td>
              <td>{t.title}</td>
              <td>{t.roleName ?? "—"}</td>
              <td>{t.priority}</td>
              <td>
                <span className={`tag status-${t.status}`}>{t.status}</span>
                {isRunning(t) && <span className="tag running"> running</span>}
              </td>
              <td>
                {t.prUrl ? (
                  <a
                    href={t.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {t.prNumber ? `#${t.prNumber}` : "PR"}
                  </a>
                ) : (
                  "—"
                )}
              </td>
            </tr>
          ))}
          {order.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
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
          Every ticket is triaged by the orchestrator agent, which assigns it to a worker, opens a
          PR for its work, or closes it. Assignment is managed automatically.
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
