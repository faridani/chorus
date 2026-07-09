import { useState } from "react";
import { api, type Role } from "../api.js";
import { StringListEditor } from "./StringListEditor.js";

/** Manage the project's agents (roles): persona, guardrails, backend, model. */
export function AgentsTab({
  projectId,
  roles,
  onChange,
}: {
  projectId: string;
  roles: Role[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Role | "new" | null>(null);

  return (
    <div>
      <div className="tabhead">
        <h3>Agents ({roles.length})</h3>
        <button className="primary" onClick={() => setEditing("new")}>
          + New agent
        </button>
      </div>

      <div className="agentgrid">
        {roles.map((r) => (
          <div key={r.id} className="agentcard" onClick={() => setEditing(r)}>
            <div className="agentname">
              {r.name} <span className="muted">[{r.backendId}{r.model ? ` · ${r.model}` : ""}]</span>
            </div>
            <div className="muted">{r.description}</div>
            <div className="agentrules">
              <div>
                <strong>allowed</strong>
                <ul>
                  {r.allowed.slice(0, 4).map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong>forbidden</strong>
                <ul>
                  {r.forbidden.slice(0, 4).map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        ))}
        {roles.length === 0 && <p className="muted">No agents defined yet.</p>}
      </div>

      {editing && (
        <RoleEditor
          projectId={projectId}
          role={editing === "new" ? null : editing}
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

function RoleEditor({
  projectId,
  role,
  onClose,
  onSaved,
}: {
  projectId: string;
  role: Role | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [allowed, setAllowed] = useState<string[]>(role?.allowed ?? []);
  const [forbidden, setForbidden] = useState<string[]>(role?.forbidden ?? []);
  const [backendId, setBackendId] = useState(role?.backendId ?? "codex");
  const [model, setModel] = useState(role?.model ?? "");
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
        <h3>{role ? `Edit agent: ${role.name}` : "New agent"}</h3>
        <label>Name</label>
        <input
          value={name}
          disabled={!!role}
          placeholder="e.g. qa, product-designer"
          onChange={(e) => setName(e.target.value)}
        />
        {role && <div className="hint">Name is the identifier and can't be changed.</div>}
        <label>Description / persona</label>
        <textarea
          rows={3}
          value={description}
          placeholder="What this agent is responsible for"
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row2">
          <div>
            <label>Backend</label>
            <select value={backendId} onChange={(e) => setBackendId(e.target.value)}>
              <option value="codex">codex</option>
            </select>
          </div>
          <div>
            <label>Model (optional)</label>
            <input value={model} placeholder="default" onChange={(e) => setModel(e.target.value)} />
          </div>
        </div>
        <label>Allowed actions</label>
        <StringListEditor items={allowed} onChange={setAllowed} placeholder="e.g. run tests" />
        <label>Forbidden actions (guardrails)</label>
        <StringListEditor items={forbidden} onChange={setForbidden} placeholder="e.g. delete data" />

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          {role && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete agent "${role.name}"?`))
                  void run(() => api.deleteRole(projectId, role.name));
              }}
            >
              Delete
            </button>
          )}
          <button
            className="primary"
            disabled={busy || !name}
            onClick={() =>
              run(() =>
                api.upsertRole(projectId, {
                  name,
                  description,
                  allowed,
                  forbidden,
                  backendId,
                  model: model.trim() || undefined,
                }),
              )
            }
          >
            {role ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
