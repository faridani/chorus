/**
 * Global gallery of "loops" — ordered pipelines built from Agent Gallery agents
 * that hand a ticket from one role to the next and back to the orchestrator.
 *
 * Placeholder for now: shows the concept and one example loop. Editing and
 * persistence will be wired up later.
 */

/** One illustrative loop. Each step references an agent from the Agent Gallery. */
const EXAMPLE_LOOP: { name: string; steps: string[] } = {
  name: "Feature delivery",
  steps: [
    "Orchestrator",
    "Feature Designer",
    "Orchestrator",
    "Software Dev",
    "Test and QA",
    "Orchestrator (PR and close ticket)",
  ],
};

export function LoopGallery() {
  return (
    <div className="gallery">
      <button className="primary newproj-btn" disabled title="Coming soon">
        + New loop
      </button>
      <p className="muted">
        Loops chain Agent Gallery agents into a pipeline that passes a ticket
        from role to role and back to the orchestrator. (Placeholder — not yet
        editable.)
      </p>
      <ul className="gallery-list">
        <li className="gallery-item">
          <div className="gi-head">
            <strong>{EXAMPLE_LOOP.name}</strong>
            <span className="muted"> [example]</span>
          </div>
          <div className="loop-steps">
            {EXAMPLE_LOOP.steps.map((step, i) => (
              <div key={i}>
                {i > 0 && <div className="loop-arrow">↓</div>}
                <div className="loop-step">{step}</div>
              </div>
            ))}
          </div>
        </li>
      </ul>
    </div>
  );
}
