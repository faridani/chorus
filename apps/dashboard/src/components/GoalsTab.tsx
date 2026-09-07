import { useEffect, useState } from "react";
import { api, type Project } from "../api.js";
import { StringListEditor } from "./StringListEditor.js";

/**
 * Project goals: the high-level expectations and project-wide ground rules
 * (both injected into every agent's prompt) plus a read-only view of the spec
 * (SPEC.md) the tickets were generated from.
 */
export function GoalsTab({ project, onSaved }: { project: Project; onSaved: () => void }) {
  const [expectations, setExpectations] = useState(project.expectations);
  const [groundRules, setGroundRules] = useState<string[]>(project.groundRules);
  const [busy, setBusy] = useState(false);

  // Re-sync if the project reloads underneath us.
  useEffect(() => {
    setExpectations(project.expectations);
    setGroundRules(project.groundRules);
  }, [project.id]);

  // Lazily load the spec contents (only when this tab is mounted).
  const [spec, setSpec] = useState<{ path: string | null; content: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    setSpec(null);
    void api
      .projectSpec(project.id)
      .then((s) => alive && setSpec(s))
      .catch(() => alive && setSpec({ path: project.specPath, content: null }));
    return () => {
      alive = false;
    };
  }, [project.id]);

  const dirty =
    expectations !== project.expectations ||
    JSON.stringify(groundRules) !== JSON.stringify(project.groundRules);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateProject(project.id, { expectations, groundRules });
      onSaved();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings">
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
          Added to every agent's guardrails. Built-in safety rules (never push, never touch the
          base branch, commit your work) always apply and can't be removed.
        </div>
      </div>

      <button className="primary" disabled={!dirty || busy} onClick={save}>
        {busy ? "Saving…" : dirty ? "Save goals" : "Saved"}
      </button>

      <div className="field" title={TIPS.spec}>
        <label>Spec{spec?.path ? ` (${spec.path})` : ""}</label>
        {spec === null ? (
          <div className="hint">Loading spec…</div>
        ) : spec.content ? (
          <pre className="spec-content">{spec.content}</pre>
        ) : (
          <div className="hint">
            {spec.path
              ? "Spec file not found in the checkout."
              : "No spec on file for this project yet."}
          </div>
        )}
      </div>
    </div>
  );
}

const TIPS = {
  expectations:
    "A plain-language description of what this project is and what 'good' looks like — goals, priorities, and constraints. This text is injected verbatim into every agent's prompt so all agents share the same high-level intent beyond the per-ticket details.",
  groundRules:
    "Project-wide rules added to EVERY agent's guardrails, on top of each role's own allowed/forbidden lists. Use them for conventions like 'always add tests' or 'never edit generated files'. Built-in safety rules (never push, never touch the base branch, always commit) always apply and can't be removed here.",
  spec: "The specification Chorus read to generate this project's tickets. Read-only here — it lives in the repo at the spec path.",
} as const;
