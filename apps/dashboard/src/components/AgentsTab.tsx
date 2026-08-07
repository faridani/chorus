import { useEffect, useState } from "react";
import { type AgentTemplate, api, type BackendInfo, type Role, type ToolDef } from "../api.js";
import { StringListEditor } from "./StringListEditor.js";
import { summarizeTools, ToolPermissionEditor } from "./ToolPermissionEditor.js";

/** Manage the project's agents (roles): persona, guardrails, tools, backend, model. */
export function AgentsTab({
  projectId,
  roles,
  backends,
  tools,
  onChange,
}: {
  projectId: string;
  roles: Role[];
  backends: BackendInfo[];
  tools: ToolDef[];
  onChange: () => void;
}) {
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const [choosing, setChoosing] = useState(false);

  return (
    <div>
      <div className="tabhead">
        <h3>Agents ({roles.length})</h3>
        <button className="primary" onClick={() => setChoosing(true)}>
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
            {(r.allowedToolIds?.length || r.forbiddenToolIds?.length) && (
              <div className="muted agenttools">
                {summarizeTools(r.allowedToolIds ?? [], r.forbiddenToolIds ?? [])}
              </div>
            )}
          </div>
        ))}
        {roles.length === 0 && <p className="muted">No agents defined yet.</p>}
      </div>

      {choosing && (
        <NewAgentChooser
          projectId={projectId}
          existingRoleNames={roles.map((r) => r.name)}
          onClose={() => setChoosing(false)}
          onCreateNew={() => {
            setChoosing(false);
            setEditing("new");
          }}
          onAdded={() => {
            setChoosing(false);
            onChange();
          }}
        />
      )}

      {editing && (
        <RoleEditor
          projectId={projectId}
          role={editing === "new" ? null : editing}
          backends={backends}
          tools={tools}
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

/** Choose how to add an agent: from the gallery, or create a new one. */
function NewAgentChooser({
  projectId,
  existingRoleNames,
  onClose,
  onCreateNew,
  onAdded,
}: {
  projectId: string;
  existingRoleNames: string[];
  onClose: () => void;
  onCreateNew: () => void;
  onAdded: () => void;
}) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const existing = new Set(existingRoleNames);

  useEffect(() => {
    void api.agentTemplates().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  const add = async (t: AgentTemplate) => {
    setBusy(true);
    try {
      // Server copies tool permissions from the template too.
      await api.applyTemplate(projectId, t.name);
      onAdded();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Add an agent</h3>

        <button className="primary" onClick={onCreateNew}>
          + Create a new agent
        </button>

        <label style={{ marginTop: 14 }}>Or add one from the Agent Gallery</label>
        <div className="hint">
          Gallery agents are shared across projects. They don't take any work until added here.
        </div>
        <ul className="chooser-list">
          {templates.map((t) => {
            const added = existing.has(t.name);
            return (
              <li key={t.id}>
                <div className="ci-text">
                  <strong>{t.name}</strong>{" "}
                  <span className="muted">[{t.backendId}{t.model ? ` · ${t.model}` : ""}]</span>
                  <div className="muted">{t.description || "—"}</div>
                </div>
                <button disabled={busy || added} onClick={() => add(t)}>
                  {added ? "Added" : "Add"}
                </button>
              </li>
            );
          })}
          {templates.length === 0 && (
            <li className="muted">
              No gallery agents yet — create them in the “Agent Gallery” tab on the left.
            </li>
          )}
        </ul>

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function RoleEditor({
  projectId,
  role,
  backends,
  tools,
  onClose,
  onSaved,
}: {
  projectId: string;
  role: Role | null;
  backends: BackendInfo[];
  tools: ToolDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [allowed, setAllowed] = useState<string[]>(role?.allowed ?? []);
  const [forbidden, setForbidden] = useState<string[]>(role?.forbidden ?? []);
  const [allowedToolIds, setAllowedToolIds] = useState<string[]>(role?.allowedToolIds ?? []);
  const [forbiddenToolIds, setForbiddenToolIds] = useState<string[]>(role?.forbiddenToolIds ?? []);
  const [backendId, setBackendId] = useState(role?.backendId ?? "codex");
  const [model, setModel] = useState(role?.model ?? "");
  const [busy, setBusy] = useState(false);

  // Backends to offer: detected + available; ensure the role's current backend
  // is present even if not detected, and always keep codex as a fallback.
  const known = backends.length ? backends : [];
  const selectable = known.filter((b) => b.available);
  const currentBackend = known.find((b) => b.id === backendId);
  const modelOptions = currentBackend?.models ?? [];

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
            <select
              value={backendId}
              onChange={(e) => {
                setBackendId(e.target.value);
                setModel(""); // reset model when backend changes
              }}
            >
              {selectable.length === 0 && <option value="codex">codex</option>}
              {selectable.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.implemented}>
                  {b.label}
                  {b.implemented ? "" : " (detected — not wired yet)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Model (optional)</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">
                {currentBackend?.defaultModel
                  ? `default (${currentBackend.defaultModel})`
                  : "default"}
              </option>
              {modelOptions.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
              {model && !modelOptions.includes(model) && <option value={model}>{model}</option>}
            </select>
          </div>
        </div>
        <label>Allowed actions</label>
        <StringListEditor items={allowed} onChange={setAllowed} placeholder="e.g. run tests" />
        <label>Forbidden actions (guardrails)</label>
        <StringListEditor items={forbidden} onChange={setForbidden} placeholder="e.g. delete data" />

        <label>Chorus tools</label>
        <div className="hint">Mark each tool Allowed (✓), Disallowed (✕), or Unspecified (–).</div>
        <ToolPermissionEditor
          tools={tools}
          allowed={allowedToolIds}
          forbidden={forbiddenToolIds}
          onChange={(a, f) => {
            setAllowedToolIds(a);
            setForbiddenToolIds(f);
          }}
        />

        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          {role && role.name !== "orchestrator" && (
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
          {role && role.name === "orchestrator" && (
            <span className="hint" style={{ alignSelf: "center" }}>
              The orchestrator agent can't be deleted.
            </span>
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
                  allowedToolIds,
                  forbiddenToolIds,
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
