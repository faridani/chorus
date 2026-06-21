import { useEffect, useState } from "react";
import { api, type SelfHealProposal, type SelfHealResult } from "../api.js";

type ProposalState = "open" | "applying" | "accepted" | "rejected" | "error";

/**
 * Self-Heal modal (in-window). Runs a read-only analysis of a ticket's
 * messages/logs/traces and proposes changes to the agents and project goals.
 * Each proposal can be accepted (applied to the role/goal) or rejected.
 */
export function SelfHealModal({
  projectId,
  ticketId,
  ticketTitle,
  liveEvents,
  onClose,
  onApplied,
}: {
  projectId: string;
  ticketId: string;
  ticketTitle?: string;
  liveEvents: unknown[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const [result, setResult] = useState<SelfHealResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, ProposalState>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    api
      .selfHeal(projectId, ticketId, liveEvents)
      .then((r) => !cancelled && setResult(r))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const accept = async (p: SelfHealProposal) => {
    setStates((s) => ({ ...s, [p.id]: "applying" }));
    try {
      await api.applySelfHealProposal(projectId, p);
      setStates((s) => ({ ...s, [p.id]: "accepted" }));
      onApplied();
    } catch (e) {
      setStates((s) => ({ ...s, [p.id]: "error" }));
      setErrors((m) => ({ ...m, [p.id]: String(e) }));
    }
  };
  const reject = (p: SelfHealProposal) => setStates((s) => ({ ...s, [p.id]: "rejected" }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal selfheal" onClick={(e) => e.stopPropagation()}>
        <h3>Self Heal{ticketTitle ? ` — ${ticketTitle}` : ""}</h3>

        {!result && !error && <p className="muted">Studying this ticket's messages, logs, and traces…</p>}
        {error && <p className="warn">{error}</p>}

        {result && (
          <div className="selfheal-body">
            <p>{result.summary || "No summary."}</p>
            {result.proposals.length === 0 ? (
              <p className="muted">No changes proposed — the agents look healthy for this ticket.</p>
            ) : (
              <>
                <label>Proposed changes</label>
                {result.proposals.map((p) => {
                  const st = states[p.id] ?? "open";
                  return (
                    <div key={p.id} className={`selfheal-proposal st-${st}`}>
                      <div className="selfheal-proposal-head">
                        <span className="tag">{proposalTarget(p)}</span>
                        <strong>{p.title || "(untitled)"}</strong>
                      </div>
                      {p.rationale && <div className="muted">{p.rationale}</div>}
                      <ProposalDetails p={p} />
                      {st === "error" && <div className="warn">{errors[p.id]}</div>}
                      <div className="selfheal-proposal-actions">
                        {st === "accepted" ? (
                          <span className="diag-success">✓ Applied</span>
                        ) : st === "rejected" ? (
                          <span className="muted">Rejected</span>
                        ) : (
                          <>
                            <button
                              className="primary"
                              disabled={st === "applying"}
                              onClick={() => void accept(p)}
                            >
                              {st === "applying" ? "Applying…" : "Accept"}
                            </button>
                            <button disabled={st === "applying"} onClick={() => reject(p)}>
                              Reject
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function proposalTarget(p: SelfHealProposal): string {
  if (p.kind === "role") return `Agent: ${p.roleName ?? "?"}`;
  if (p.kind === "expectations") return "Project: expectations";
  return "Project: ground rules";
}

function ProposalDetails({ p }: { p: SelfHealProposal }) {
  if (p.kind === "expectations") {
    return (
      <div className="selfheal-detail">
        <pre>{p.expectations || "(empty)"}</pre>
      </div>
    );
  }
  if (p.kind === "ground_rules") {
    return (
      <ul className="selfheal-detail-list">
        {(p.groundRules ?? []).map((g, i) => (
          <li key={i}>{g}</li>
        ))}
      </ul>
    );
  }
  // role
  const rows: Array<[string, string]> = [];
  if (p.description?.trim()) rows.push(["description", p.description]);
  if (p.allowed?.length) rows.push(["allowed", p.allowed.join("; ")]);
  if (p.forbidden?.length) rows.push(["forbidden", p.forbidden.join("; ")]);
  if (p.allowedToolIds?.length) rows.push(["grant tools", p.allowedToolIds.join(", ")]);
  if (p.forbiddenToolIds?.length) rows.push(["deny tools", p.forbiddenToolIds.join(", ")]);
  if (p.model?.trim()) rows.push(["model", p.model]);
  if (rows.length === 0) return <div className="muted selfheal-detail">No field changes specified.</div>;
  return (
    <div className="selfheal-detail">
      {rows.map(([k, v]) => (
        <div key={k}>
          <span className="muted">{k}: </span>
          {v}
        </div>
      ))}
    </div>
  );
}
