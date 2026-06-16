import { useEffect, useState } from "react";
import { api, type DiagnosisResult } from "../api.js";

/**
 * Trace Diagnosis modal. Runs a read-only Codex analysis of recent traces
 * (project-scope or ticket-scope) and, if the model proposes a concrete fix,
 * lets the user file it as a high-priority ticket via the existing ticket API.
 */
export function DebugTracesModal({
  projectId,
  ticketId,
  ticketTitle,
  liveEvents,
  onClose,
  onTicketCreated,
}: {
  projectId: string;
  ticketId: string | null;
  ticketTitle?: string;
  liveEvents: unknown[];
  onClose: () => void;
  onTicketCreated: () => void;
}) {
  const [result, setResult] = useState<DiagnosisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filing, setFiling] = useState(false);
  const [created, setCreated] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const run = ticketId
      ? api.debugTracesTicket(projectId, ticketId, liveEvents)
      : api.debugTraces(projectId, liveEvents);
    run
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const proposal = result?.ticket;
  const hasProposal = !!(result?.status === "needs_ticket" && proposal?.title.trim());
  const disabledReason =
    result?.status === "working_as_expected"
      ? "The agents are working as expected."
      : "No actionable ticket was proposed.";

  const fileTicket = async () => {
    if (!hasProposal || !proposal || filing || created) return;
    setFiling(true);
    try {
      await api.addTicket(projectId, {
        title: proposal.title,
        body: proposal.body,
        priority: proposal.priority && proposal.priority > 0 ? proposal.priority : 100,
        roleName: proposal.roleName?.trim() || undefined,
        fromDiagnostic: true,
      });
      setCreated(true);
      onTicketCreated();
    } catch (e) {
      setError(String(e));
    } finally {
      setFiling(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Trace Diagnosis{ticketId ? ` — ${ticketTitle ?? "ticket"}` : ""}</h3>

        {!result && !error && <p className="muted">Analyzing recent traces…</p>}
        {error && <p className="warn">{error}</p>}

        {result && (
          <div className="diag">
            <div className="diag-head">
              <span className={`tag diag-${result.status}`}>{result.status}</span>
              <span className="muted"> confidence {(result.confidence * 100).toFixed(0)}%</span>
            </div>
            <p>{result.summary}</p>

            {result.evidence.length > 0 && (
              <>
                <label>Evidence</label>
                <ul className="diag-list">
                  {result.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </>
            )}
            {result.risks.length > 0 && (
              <>
                <label>Risks</label>
                <ul className="diag-list">
                  {result.risks.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            )}
            {result.recommendedAction && (
              <>
                <label>Recommended action</label>
                <p>{result.recommendedAction}</p>
              </>
            )}
            {hasProposal && proposal && (
              <>
                <label>Proposed ticket</label>
                <div className="diag-proposal">
                  <strong>{proposal.title}</strong>
                  <div className="muted">{proposal.body}</div>
                </div>
              </>
            )}
            {created && <p className="diag-success">✓ Ticket created — see the Tickets tab (top of the list).</p>}
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <button
            className="primary"
            disabled={!hasProposal || filing || created}
            title={hasProposal ? "File the proposed ticket" : disabledReason}
            onClick={fileTicket}
          >
            {created ? "Created" : filing ? "Creating…" : "Ticket to solve"}
          </button>
        </div>
      </div>
    </div>
  );
}
