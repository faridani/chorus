/**
 * Status / state enums used across Chorus. These are the spine of the
 * orchestrator's state machine — kept as string-literal unions so they map
 * cleanly onto SQLite TEXT columns and onto JSON over the wire.
 */

/** Lifecycle of a ticket (a unit of work the human/orchestrator defines). */
export const TICKET_STATUSES = [
  "open", // the current assignee should act on it
  "assigned", // (legacy) picked up by the orchestrator, task created
  "in_progress", // an agent is actively running on it (transient)
  "needs_review", // (legacy) agent finished, awaiting human
  "merged", // work merged into the integration branch (terminal)
  "closed", // closed by the orchestrator without a merge (terminal)
  "blocked", // cannot proceed (e.g. conflict, needs a human/agent that doesn't exist)
  "failed", // gave up after exhausting attempts
] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Rich terminal/working states for a single task attempt. A boolean "done"
 * is intentionally avoided — the orchestrator branches on these to decide
 * whether to merge, notify, retry, or wait.
 */
export const TASK_STATES = [
  "queued", // created, waiting for dispatch
  "running", // agent process is live
  "done-pending-merge", // clean exit + valid output + real commit → eligible to merge
  "done-no-changes", // clean exit but no commit produced
  "done-tests-failing", // clean exit + commit but the verification gate failed
  "done-unverified", // clean exit but output file missing/invalid (commit may exist)
  "partial", // exited with uncommitted changes left in the worktree
  "paused-quota", // suspended because the account quota is exhausted
  "merged", // successfully merged into the integration branch
  "conflicted", // merge into integration hit a conflict (left for human)
  "failed", // crashed / non-zero exit / gave up
  "interrupted", // daemon restarted while this was running (process is gone)
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** States that mean the agent process is no longer running. */
export const TERMINAL_TASK_STATES: ReadonlySet<TaskState> = new Set<TaskState>([
  "done-pending-merge",
  "done-no-changes",
  "done-tests-failing",
  "done-unverified",
  "partial",
  "merged",
  "conflicted",
  "failed",
  "interrupted",
]);

/** Outcome of attempting to merge an agent branch into integration. */
export const MERGE_STATUSES = ["merged", "conflicted", "skipped"] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

/**
 * How an agent run ended, as classified from exit code/signal/output.
 * Distinct from TaskState: this describes the *process*, the task state is
 * derived from this plus git inspection.
 */
export const TERMINAL_REASONS = [
  "completed", // process exited cleanly
  "quota_exhausted", // detected subscription quota/rate limit
  "failed", // non-zero exit not attributable to quota
  "killed", // we deliberately stopped it (stop/pause)
  "timeout", // exceeded hard wall-clock cap
  "idle_timeout", // emitted no events for too long → assumed hung
  "crashed", // died on a signal we did not send
  "unknown", // could not be classified (logged for later learning)
] as const;
export type TerminalReason = (typeof TERMINAL_REASONS)[number];

/** Account-global quota state (subscription CLIs share one pool). */
export const QUOTA_STATES = ["available", "exhausted"] as const;
export type QuotaState = (typeof QUOTA_STATES)[number];

/** Whether the orchestrator loop is actively dispatching work. */
export const ORCHESTRATOR_STATES = ["stopped", "running", "paused"] as const;
export type OrchestratorState = (typeof ORCHESTRATOR_STATES)[number];
