import React from "react";

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal about-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="about-dialog-title">About Chorus</h3>

        <div className="about-body">
          <p>
            Chorus is an implementation of <strong>goal-oriented software engineering</strong>: you describe where a
            repository should go, and an orchestrator turns that direction into tickets, role-based agent work, isolated
            branches, logs, and reviewable pull requests.
          </p>
          <p>
            It is designed to run continuously on a <strong>headless or clamshell server</strong>. Running this way keeps
            subscription CLI tools available around the clock, including Codex in <code>--yolo</code> mode and Claude
            Code with <code>--dangerously-skip-permissions</code>, while Chorus keeps the work inspectable through git
            worktrees, cost tracking, and human review before main is touched.
          </p>
          <p>
            The dashboard also includes a full terminal, so you can still use Codex, Claude, and Gemini directly
            whenever you need to inspect, intervene, or explore outside the automated loop.
          </p>
        </div>

        <div className="modal-actions">
          <button onClick={onClose} autoFocus>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
