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
      <div className="field" title={TIPS.repository}>
        <label>Repository</label>
        <div className="ro">{project.repoUrl}</div>
      </div>
      <div className="field" title={TIPS.integrationBranch}>
        <label>Integration branch (read-only)</label>
        <div className="ro">{project.integrationBranch}</div>
      </div>
      <div className="field" title={TIPS.specPath}>
        <label>Spec path</label>
        <div className="ro">{project.specPath ?? "—"}</div>
      </div>

      <div className="field" title={TIPS.baseBranch}>
        <label>Base / main branch</label>
        <input value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)} title={TIPS.baseBranch} />
        <div className="hint">
          Used as the promote target (Approve) and for new clones. Applies going forward; the
          existing integration branch is unchanged.
        </div>
      </div>

      <div className="field" title={TIPS.expectations}>
        <label>High-level expectations</label>
        <textarea
          rows={5}
          value={expectations}
          placeholder="What is this project for? What does 'good' look like? Constraints, priorities…"
          onChange={(e) => setExpectations(e.target.value)}
          title={TIPS.expectations}
        />
        <div className="hint">Injected into every agent's prompt.</div>
      </div>

      <div className="field" title={TIPS.groundRules}>
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

      <button className="primary" disabled={!dirty || busy} onClick={save} title={TIPS.save}>
        {busy ? "Saving…" : dirty ? "Save settings" : "Saved"}
      </button>
    </div>
  );
}

/** Detailed hover tooltips for each Settings field. */
const TIPS = {
  repository:
    "The GitHub repository this project works on. Cloned via the gh CLI under your authenticated account. Read-only — it's fixed when the project is created.",
  integrationBranch:
    "The branch agents merge their completed, reviewed work into (created by Chorus, e.g. chorus/integration). It is NOT your main branch. Read-only. You test this branch, then promote it to the base branch with the Approve button.",
  specPath:
    "Path inside the repo to the specification Chorus read to generate tickets (e.g. docs/SPEC.md or SPEC.md). Read-only — detected when the repo is imported, or set when you paste a spec for a repo that had none.",
  baseBranch:
    "Your repository's protected base branch (default: main). Chorus cuts the integration branch from it and, when you click Approve, merges integration back into it. Agents never modify it directly. Changing it applies going forward (used as the Approve/promote target and for new clones); the existing integration branch is left unchanged.",
  expectations:
    "A plain-language description of what this project is and what 'good' looks like — goals, priorities, and constraints. This text is injected verbatim into every agent's prompt so all agents share the same high-level intent beyond the per-ticket details.",
  groundRules:
    "Project-wide rules added to EVERY agent's guardrails, on top of each role's own allowed/forbidden lists. Use them for conventions like 'always add tests' or 'never edit generated files'. Built-in safety rules (never push, never touch the base branch, always commit) always apply and can't be removed here.",
  save: "Save these settings. They take effect for future agent runs; work already in progress is unaffected.",
} as const;
