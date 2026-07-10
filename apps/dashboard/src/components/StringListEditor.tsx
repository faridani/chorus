import { useState } from "react";

/** Edit a list of short strings (ground rules, allowed/forbidden actions). */
export function StringListEditor({
  items,
  onChange,
  placeholder,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    onChange([...items, v]);
    setDraft("");
  };
  return (
    <div className="listeditor">
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            <span>{it}</span>
            <button className="x" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              ✕
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="muted">none</li>}
      </ul>
      <div className="addrow">
        <input
          value={draft}
          placeholder={placeholder ?? "add…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        <button onClick={add}>Add</button>
      </div>
    </div>
  );
}
