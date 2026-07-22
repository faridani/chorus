import type { BackendInfo } from "../api.js";

/** Visual list of backend CLIs detected on the host and their models. */
export function ModelsPanel({ backends }: { backends: BackendInfo[] }) {
  if (backends.length === 0) {
    return <p className="muted">Detecting backends…</p>;
  }
  return (
    <ul className="backends">
      {backends.map((b) => (
        <li key={b.id} className={b.available ? "avail" : "unavail"}>
          <div className="bk-head">
            <span className={`dot ${b.available ? "on" : "off"}`} />
            <strong>{b.label}</strong>
            <span className="muted">
              {b.available ? b.version ?? "available" : "not installed"}
            </span>
            {b.available && !b.implemented && (
              <span className="tag" title="Detected on the host but Chorus has no adapter for it yet.">
                detected
              </span>
            )}
          </div>
          {b.available && (
            <div className="bk-models">
              {b.models.map((m) => (
                <span
                  key={m}
                  className={`chip ${m === b.defaultModel ? "default" : ""}`}
                  title={m === b.defaultModel ? "Configured default" : undefined}
                >
                  {m}
                  {m === b.defaultModel ? " ★" : ""}
                </span>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
