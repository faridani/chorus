import { useEffect, useState } from "react";
import { type AgentTemplate, api, type BackendInfo, type Project, type ToolDef } from "../api.js";
import { backendChoices } from "../backendChoices.js";
import { normalizeToolIds } from "../toolPermissions.js";
import { StringListEditor } from "./StringListEditor.js";
import { summarizeTools, ToolPermissionEditor } from "./ToolPermissionEditor.js";

/**
 * Global gallery of reusable agent definitions, usable across all projects.
 * Maintain templates here, then apply one to any project (creates a role).
 */
export function AgentGallery({
  backends,
  projects,
  tools,
}: {
  backends: BackendInfo[];
  projects: Project[];
  tools: ToolDef[];
}) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [editing, setEditing] = useState<AgentTemplate | "new" | null>(null);
  const [customizingId, setCustomizingId] = useState<string | null>(null);

  const refresh = () => api.agentTemplates().then(setTemplates).catch(() => setTemplates([]));
  useEffect(() => {
    void refresh();
  }, []);

  const customize = async (template: AgentTemplate) => {
    setCustomizingId(template.id);
    try {
      const created = await api.upsertAgentTemplate({
        name: nextCustomTemplateName(template.name, templates),
        description: template.description,
        allowed: [...template.allowed],
        forbidden: [...template.forbidden],
        allowedToolIds: normalizeToolIds(template.allowedToolIds),
        forbiddenToolIds: normalizeToolIds(template.forbiddenToolIds),
        backendId: template.backendId,
        model: template.model,
      });
      await refresh();
      setEditing(created);
    } catch (err) {
      alert(String(err));
    } finally {
      setCustomizingId(null);
    }
  };

  return (
    <div className="gallery">
      <button className="primary newproj-btn" onClick={() => setEditing("new")}>
        + New agent
      </button>
      {templates.length === 0 && <p className="muted">No gallery agents yet.</p>}
      <ul className="gallery-list">
        {templates.map((t) => (
          <li key={`${t.source}:${t.id}`} className={`gallery-item source-${t.source}`}>
            <div className="gi-head">
              <strong>{t.displayName || t.name}</strong>
              <span className={`tag source-tag source-${t.source}`}>{t.source === "builtin" ? "Built-in" : "Custom"}</span>
              <span className="muted"> [{t.backendId}{t.model ? ` · ${t.model}` : ""}]</span>
            </div>
            <div className="muted gi-meta">
              <code>{t.name}</code> · {t.category}{t.version ? ` · v${t.version}` : ""}
            </div>
            <div className="muted gi-desc">
              {t.description || "—"}
            </div>
            {(t.allowedToolIds?.length || t.forbiddenToolIds?.length) && (
              <div className="muted gi-tools">
                {summarizeTools(t.allowedToolIds ?? [], t.forbiddenToolIds ?? [])}
              </div>
            )}
            <div className="gi-actions">
              <UseInProject template={t} projects={projects} />
              {t.readOnly ? (
                <button
                  disabled={customizingId === t.id}
                  onClick={() => void customize(t)}
                  title="Create an editable custom gallery agent from this built-in agent."
                >
                  Customize
                </button>
              ) : (
                <button onClick={() => setEditing(t)} title="Edit this custom gallery agent.">
                  Edit
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>

      {editing && (
        <TemplateEditor
          template={editing === "new" ? null : editing}
          backends={backends}
          tools={tools}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function nextCustomTemplateName(baseName: string, templates: AgentTemplate[]): string {
  const existing = new Set(templates.map((t) => t.name));
  const base = `${baseName}-custom`;
  if (!existing.has(base)) return base;
  for (let i = 2; ; i += 1) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

function UseInProject({ template, projects }: { template: AgentTemplate; projects: Project[] }) {
  const [projectId, setProjectId] = useState("");
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (!projectId) return;
    setBusy(true);
    try {
      // Server copies tool permissions from the template into the new role.
      await api.applyTemplate(projectId, template);
      alert(`Added "${template.displayName || template.name}" to the project.`);
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="gi-use">
      <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
        <option value="">use in project…</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "")}
          </option>
        ))}
      </select>
      <button disabled={!projectId || busy} onClick={apply} title="Create a role from this gallery agent in the chosen project.">
        Use
      </button>
    </div>
  );
}

function TemplateEditor({
  template,
  backends,
  tools,
  onClose,
  onSaved,
}: {
  template: AgentTemplate | null;
  backends: BackendInfo[];
  tools: ToolDef[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [allowed, setAllowed] = useState<string[]>(template?.allowed ?? []);
  const [forbidden, setForbidden] = useState<string[]>(template?.forbidden ?? []);
  const [allowedToolIds, setAllowedToolIds] = useState<string[]>(normalizeToolIds(template?.allowedToolIds));
  const [forbiddenToolIds, setForbiddenToolIds] = useState<string[]>(normalizeToolIds(template?.forbiddenToolIds));
  const [backendId, setBackendId] = useState(template?.backendId ?? "codex");
  const [model, setModel] = useState(template?.model ?? "");
  const [busy, setBusy] = useState(false);

  const selectable = backendChoices(backends, backendId, model);
  const current = selectable.find((b) => b.id === backendId);
  const modelOptions = current?.models ?? [];

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
        <h3>{template ? `Edit gallery agent: ${template.name}` : "New gallery agent"}</h3>
        <label>Name</label>
        <input
          value={name}
          disabled={!!template}
          placeholder="e.g. pr-review-evaluator"
          onChange={(e) => setName(e.target.value)}
        />
        {template && <div className="hint">Name is the identifier and can't be changed.</div>}
        <label>Description / persona</label>
        <textarea
          rows={3}
          value={description}
          placeholder="e.g. Reads PR review comments, evaluates them, and files tickets for the valid ones."
          onChange={(e) => setDescription(e.target.value)}
        />
        <div className="row2">
          <div>
            <label>Backend</label>
            <select
              value={backendId}
              onChange={(e) => {
                setBackendId(e.target.value);
                setModel("");
              }}
            >
              {selectable.map((b) => (
                <option key={b.id} value={b.id} disabled={!b.available || !b.implemented}>
                  {b.label}
                  {!b.available ? " (not installed)" : b.implemented ? "" : " (detected — not wired yet)"}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label>Model (optional)</label>
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">{current?.defaultModel ? `default (${current.defaultModel})` : "default"}</option>
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
        <StringListEditor items={allowed} onChange={setAllowed} placeholder="e.g. file tickets" />
        <label>Forbidden actions (guardrails)</label>
        <StringListEditor items={forbidden} onChange={setForbidden} placeholder="e.g. close PRs" />

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
          {template && !template.readOnly && (
            <button
              className="danger"
              disabled={busy}
              onClick={() => {
                if (confirm(`Delete gallery agent "${template.name}"?`))
                  void run(() => api.deleteAgentTemplate(template.name));
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
                api.upsertAgentTemplate({
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
            {template ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
