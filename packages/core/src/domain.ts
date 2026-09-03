import type { QuotaState, TaskState, TerminalReason, TicketStatus } from "./state.js";

/** A project = one GitHub repo Chorus is working on. */
export interface Project {
  id: string;
  repoUrl: string;
  /** Local path of the canonical clone. */
  localPath: string;
  /** Base branch that ticket branches are cut from and PRs target (e.g. `main`). */
  baseBranch: string;
  /** Path to the spec within the repo, if found (e.g. docs/SPEC.md). */
  specPath: string | null;
  /** High-level expectations / vision for the project (injected into prompts). */
  expectations: string;
  /** Project-wide ground rules every agent must follow (injected into prompts). */
  groundRules: string[];
  /** One-time setup command run in each fresh worktree (e.g. `npm install`). */
  setupCommand: string | null;
  /** Ordered build/test/lint commands used to verify an attempt before a PR. */
  verifyCommands: string[];
  /** Whether command auto-detection has run for this project (once-only backfill gate). */
  commandsDetected: boolean;
  status: "initializing" | "needs_spec" | "ready" | "error";
  /** Per-project dispatch control (independent of other projects). */
  runState: ProjectRunState;
  /** When idle (queue drained), auto-generate follow-up tickets. Off by default. */
  idleIdeation: boolean;
  /** How many tickets to ideate per idle pass when `idleIdeation` is on (1–10). */
  idleIdeationCount: number;
  createdAt: number;
}

/**
 * Whether the orchestrator dispatches work for a project:
 * - `running`  — assign tickets to agents normally.
 * - `paused`   — stop assigning NEW tickets; agents already working finish.
 * - `stopped`  — stop assigning AND stop any agents currently working.
 */
export type ProjectRunState = "running" | "paused" | "stopped";

/** The per-project triage agent's role name. Auto-created and undeletable. */
export const ORCHESTRATOR_ROLE = "orchestrator";

/**
 * A reusable, project-independent agent definition kept in the "Agent Gallery".
 * Same shape as a Role but global — it can be applied to any project (which
 * creates a project Role from it). E.g. a "PR review evaluator" agent.
 */
export interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  /** Catalog tool ids this agent is explicitly granted. */
  allowedToolIds: string[];
  /** Catalog tool ids this agent is explicitly denied. */
  forbiddenToolIds: string[];
  backendId: string;
  model?: string;
  createdAt: number;
}

export type AgentTemplateSource = "builtin" | "custom";

/**
 * What the Agent Gallery API returns. Built-ins are source-owned definitions
 * loaded from repo files; custom entries are persisted user templates enriched
 * with source metadata for the UI.
 */
export interface AgentGalleryTemplate {
  id: string;
  name: string;
  displayName: string;
  description: string;
  allowed: string[];
  forbidden: string[];
  allowedToolIds: string[];
  forbiddenToolIds: string[];
  backendId: string;
  model?: string;
  category: string;
  version?: string;
  source: AgentTemplateSource;
  readOnly: boolean;
  createdAt?: number;
}

/** A role defines an agent persona: its job and its guardrails. */
export interface Role {
  id: string;
  projectId: string;
  name: string;
  /** Plain-language description of the role's responsibility. */
  description: string;
  /** Things this role is explicitly allowed to do (free-text guardrails). */
  allowed: string[];
  /** Things this role must never do (free-text guardrails). */
  forbidden: string[];
  /** Catalog tool ids this role is explicitly granted. */
  allowedToolIds: string[];
  /** Catalog tool ids this role is explicitly denied. */
  forbiddenToolIds: string[];
  /** Backend id to use for this role (e.g. "codex"). */
  backendId: string;
  /** Optional model override. */
  model?: string;
}

/** A ticket = a unit of work, defined by the human or generated from the spec. */
export interface Ticket {
  id: string;
  projectId: string;
  title: string;
  body: string;
  status: TicketStatus;
  /** Current assignee (role name): "orchestrator" or a worker role. */
  roleName: string | null;
  priority: number;
  source: "spec" | "manual";
  /** Persistent work branch for this ticket (created on first worker run). */
  branch: string | null;
  /** Persistent worktree path for this ticket's branch. */
  worktreePath: string | null;
  /** URL of the GitHub PR opened for this ticket's branch, once opened. */
  prUrl: string | null;
  /** Number of the GitHub PR, once opened. */
  prNumber: number | null;
  /** User-set flag to mark a ticket for attention. Display-only; no behavior. */
  starred: boolean;
  createdAt: number;
  updatedAt: number;
}

/** One entry in a ticket's activity trail (agent messages + work done). */
export interface TicketEvent {
  id: string;
  projectId: string;
  ticketId: string;
  /** Who produced it: a role name ("orchestrator"/worker) or "system". */
  actor: string;
  kind: "triage" | "work" | "pr" | "close" | "note";
  message: string;
  createdAt: number;
}

/** A message from the orchestrator to the human, shown in the Suggestions tab. */
export interface Suggestion {
  id: string;
  projectId: string;
  ticketId: string | null;
  message: string;
  status: "open" | "dismissed";
  createdAt: number;
}

/** The structured decision the orchestrator agent returns when triaging a ticket. */
export interface OrchestratorDecision {
  action: "assign" | "open_pr" | "close" | "needs_human";
  /** For "assign": the worker role to hand the ticket to. */
  assignee?: string;
  /** Optional reprioritization. */
  priority?: number;
  /** Follow-up tickets to create (assigned to the orchestrator). */
  newTickets?: { title: string; body: string; priority?: number }[];
  /** Messages to surface to the human. */
  suggestions?: string[];
  /** A one-line explanation recorded in the ticket trail. */
  message: string;
}

/** A single attempt at a ticket. A ticket may have several over time. */
export interface Task {
  id: string;
  ticketId: string;
  projectId: string;
  backendId: string;
  worktreePath: string;
  branch: string;
  /** Commit the worktree branch was cut from. */
  baseCommit: string;
  state: TaskState;
  attempt: number;
  /** Set when paused for quota: when to attempt resume. */
  resumeAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
}

/** One spawn of a backend CLI for a task. The forensic record. */
export interface AgentRun {
  id: string;
  taskId: string;
  pid: number | null;
  pgid: number | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  exitSignal: string | null;
  terminalReason: TerminalReason | null;
  rawLogPath: string | null;
  outputFilePath: string | null;
}

/** A GitHub pull request opened for a ticket's branch. */
export interface PullRequest {
  id: string;
  ticketId: string;
  projectId: string;
  /** The task (attempt) whose accepted branch this PR was opened from. */
  taskId: string | null;
  /** Web URL of the PR. */
  url: string;
  /** PR number, if known. */
  number: number | null;
  /** GitHub PR state: OPEN | MERGED | CLOSED. */
  state: string;
  createdAt: number;
  updatedAt: number;
}

/** A human-facing changelog entry. */
export interface ChangelogEntry {
  id: string;
  projectId: string;
  ticketId: string | null;
  /** The pull request this entry relates to, if any. */
  prId: string | null;
  entry: string;
  agentRole: string | null;
  createdAt: number;
}

/**
 * A structured, reflective record of one worker attempt: what was tried, how it
 * was verified, why it failed (or the proof it passed), and what happens next.
 * This is the loop's reflective memory — read back to seed the next attempt.
 */
export interface AttemptJournalEntry {
  id: string;
  taskId: string;
  ticketId: string;
  projectId: string;
  attempt: number;
  /** sha256 of the worker prompt that produced this attempt. */
  promptHash: string | null;
  /** sha256 of `git diff base..branch` after the attempt. */
  diffHash: string | null;
  /** Whether the programmatic verify commands all passed (null = not run). */
  verifyPassed: boolean | null;
  /** Truncated tail of the programmatic verify output. */
  verifyOutput: string | null;
  /** The evaluator's diagnosis of any failure. */
  diagnosis: string | null;
  /** What the loop decided to do next (e.g. "reassign: fix failing test X"). */
  nextAction: string | null;
  /** Structured evaluator verdict (JSON-serialized). */
  evaluatorVerdict: string | null;
  /** Structured reviewer verdict (JSON-serialized). */
  reviewerVerdict: string | null;
  /** On success: the PR url / passing-checks summary. */
  proof: string | null;
  createdAt: number;
}

/** A point-in-time usage/quota observation. */
export interface UsageEvent {
  id: string;
  runId: string | null;
  projectId: string | null;
  kind: "tokens" | "quota_exhausted" | "quota_reset";
  inputTokens: number | null;
  outputTokens: number | null;
  detail: string | null;
  observedAt: number;
}

/** Account-global quota singleton. */
export interface QuotaInfo {
  state: QuotaState;
  /** When dispatch may resume (null if available). */
  resumeAt: number | null;
  /** How many consecutive quota pauses we've seen (for backoff). */
  consecutivePauses: number;
  updatedAt: number;
}
