import type { ToolDef } from "../api.js";

type State = "allowed" | "disallowed" | "unspecified";

/**
 * Per-tool 3-state selector (Allowed / Disallowed / Unspecified), grouped by
 * category. Reused by the Agent Gallery template editor and the project role
 * editor. Source-defined tools are read-only as a catalog; only the per-agent
 * grant/deny is editable here.
 */
export function ToolPermissionEditor({
  tools,
  allowed,
  forbidden,
  onChange,
}: {
  tools: ToolDef[];
  allowed: string[];
  forbidden: string[];
  onChange: (allowed: string[], forbidden: string[]) => void;
}) {
  const stateOf = (id: string): State =>
    allowed.includes(id) ? "allowed" : forbidden.includes(id) ? "disallowed" : "unspecified";

  const set = (id: string, next: State) => {
    const a = new Set(allowed);
    const f = new Set(forbidden);
    a.delete(id);
    f.delete(id);
    if (next === "allowed") a.add(id);
    else if (next === "disallowed") f.add(id);
    onChange([...a], [...f]);
  };

  if (tools.length === 0) return <div className="muted">Tool catalog unavailable.</div>;

  const categories = [...new Set(tools.map((t) => t.category))];
  return (
    <div className="toolperm">
      {categories.map((cat) => (
        <div key={cat} className="toolperm-cat">
          <div className="toolperm-cat-name">{cat}</div>
          {tools
            .filter((t) => t.category === cat)
            .map((t) => {
              const st = stateOf(t.id);
              return (
                <div key={t.id} className="toolperm-row" title={t.description}>
                  <div className="toolperm-id">
                    <code>{t.id}</code>
                    {t.availability === "planned" && <span className="tag toolperm-planned">planned</span>}
                  </div>
                  <div className="toolperm-toggle">
                    {(["allowed", "unspecified", "disallowed"] as State[]).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        className={`toolperm-btn ${st === opt ? `on ${opt}` : ""}`}
                        onClick={() => set(t.id, opt)}
                        title={opt}
                      >
                        {opt === "allowed" ? "✓" : opt === "disallowed" ? "✕" : "–"}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}

/** Compact one-line summary of tool grants for agent cards. */
export function summarizeTools(allowed: string[], forbidden: string[]): string {
  const parts: string[] = [];
  if (allowed.length) parts.push(`tools: ${compactList(allowed)}`);
  if (forbidden.length) parts.push(`blocked: ${compactList(forbidden)}`);
  return parts.join(" · ");
}

function compactList(ids: string[]): string {
  const shown = ids.slice(0, 3).join(", ");
  return ids.length > 3 ? `${shown} +${ids.length - 3}` : shown;
}
