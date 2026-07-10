import { useEffect, useState } from "react";
import { api, type Project } from "../api.js";
import { StringListEditor } from "./StringListEditor.js";

/** Edit base branch, high-level expectations, and project ground rules. */
export function SettingsTab({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [baseBranch, setBaseBranch] = useState(project.baseBranch);
  const [expectations, setExpectations] = useState(project.expectations);
  const [groundRules, setGroundRules] = useState<string[]>(project.groundRules);
  const [busy, setBusy] = useState(false);

  // Re-sync if the project reloads underneath us.
  useEffect(() => {
    setBaseBranch(project.baseBranch);
    setExpectations(project.expectations);
    setGroundRules(project.groundRules);
  }, [project.id]);

  const dirty =
    baseBranch !== project.baseBranch ||
    expectations !== project.expectations ||
    JSON.stringify(groundRules) !== JSON.stringify(project.groundRules);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateProject(project.id, { baseBranch, expectations, groundRules });
      onSaved();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
      <div className="field">
        <label>Repository</label>
        <div className="ro">{project.repoUrl}</div>
      </div>
      <div className="field">
        <label>Integration branch (read-only)</label>
        <div className="ro">{project.integrationBranch}</div>
      </div>
      <div className="field">
        <label>Spec path</label>
        <div className="ro">{project.specPath ?? "—"}</div>
      </div>

      <div className="field">
        <label>Base / main branch</label>
        <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} />
        <div className="hint">
          Used as the promote target (Approve) and for new clones. Applies going forward; the
          existing integration branch is unchanged.
        </div>
      </div>

      <div className="field">
        <label>High-level expectations</label>
        <textarea
          rows={5}
          value={expectations}
          placeholder="What is this project for? What does 'good' look like? Constraints, priorities…"
          onChange={(e) => setExpectations(e.target.value)}
        />
        <div className="hint">Injected into every agent's prompt.</div>
      </div>

      <div className="field">
        <label>Ground rules (project-wide guardrails)</label>
        <StringListEditor
          items={groundRules}
          onChange={setGroundRules}
          placeholder="e.g. Always add tests for new behavior"
        />
        <div className="hint">
          Added to every agent's guardrails. Built-in safety rules (never push, never touch the base
          branch, commit your work) always apply and can't be removed.
        </div>
      </div>

      <button className="primary" disabled={!dirty || busy} onClick={save}>
        {busy ? "Saving…" : dirty ? "Save settings" : "Saved"}
      </button>
    </div>
  );
}
