import type { ToolDef } from "../api.js";

/**
 * Read-only documentation of the source-defined Chorus tool catalog, grouped by
 * category. Tools are granted/denied per agent in the Agent Gallery and project
 * Agents editors; this tab just describes what exists.
 */
export function ToolsGallery({ tools }: { tools: ToolDef[] }) {
  if (tools.length === 0) return <p className="muted">No tools available.</p>;
  const categories = [...new Set(tools.map((t) => t.category))];
  return (
    <div className="gallery">
      <p className="muted">
        Source-defined capabilities agents can be granted or denied. Read-only — grant them per
        agent in the Agent Gallery or a project's Agents tab.
      </p>
      {categories.map((cat) => (
        <div key={cat} className="tools-cat">
          <h4 className="tools-cat-name">{cat}</h4>
          <ul className="gallery-list">
            {tools
              .filter((t) => t.category === cat)
              .map((t) => (
                <li key={t.id} className="gallery-item tool-card">
                  <div className="gi-head">
                    <strong>{t.name}</strong>
                    <code className="muted tool-id"> {t.id}</code>
                  </div>
                  <div className="muted gi-desc">{t.description}</div>
                  <div className="tool-meta">
                    <span className={`tag risk-${t.risk}`}>risk: {t.risk}</span>
                    <span className="tag">{t.sideEffects ? "side effects" : "no side effects"}</span>
                    <span className={`tag avail-${t.availability}`}>{t.availability}</span>
                  </div>
                </li>
              ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
