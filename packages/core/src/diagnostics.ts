/**
 * Result of a read-only "Debug Traces" diagnostic run. The type lives in core so
 * the ControlApi contract can reference it; the Zod schema + Codex runner live in
 * @chorus/orchestrator (which depends on core).
 */
export type DiagnosisStatus = "working_as_expected" | "needs_ticket" | "uncertain";

/** A corrective ticket the diagnostician proposes. Empty `title` = no proposal. */
export interface DiagnosisTicket {
  title: string;
  body: string;
  priority: number;
  roleName: string;
}

export interface DiagnosisResult {
  status: DiagnosisStatus;
  summary: string;
  evidence: string[];
  risks: string[];
  recommendedAction: string;
  ticket: DiagnosisTicket;
  confidence: number;
}
