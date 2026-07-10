import type {
  MergeStatus,
  QuotaState,
  TaskState,
  TerminalReason,
  TicketStatus,
} from "./state.js";

/** A project = one GitHub repo Chorus is working on. */
export interface Project {
  id: string;
  repoUrl: string;
  /** Local path of the canonical clone. */
  localPath: string;
  /** Branch agents merge into (never `main`). */
  integrationBranch: string;
  /** Base branch the integration branch was cut from. */
  baseBranch: string;
  /** Path to the spec within the repo, if found (e.g. docs/SPEC.md). */
  specPath: string | null;
  /** High-level expectations / vision for the project (injected into prompts). */
  expectations: string;
  /** Project-wide ground rules every agent must follow (injected into prompts). */
  groundRules: string[];
  status: "initializing" | "needs_spec" | "ready" | "error";
  createdAt: number;
}

/** A role defines an agent persona: its job and its guardrails. */
export interface Role {
  id: string;
  projectId: string;
  name: string;
  /** Plain-language description of the role's responsibility. */
  description: string;
  /** Things this role is explicitly allowed to do. */
  allowed: string[];
  /** Things this role must never do (guardrails). */
  forbidden: string[];
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
  /** Role this ticket is assigned to (by role name). */
  roleName: string | null;
  priority: number;
  source: "spec" | "manual";
  createdAt: number;
  updatedAt: number;
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

/** A record of an attempted merge of an agent branch into integration. */
export interface Merge {
  id: string;
  taskId: string;
  projectId: string;
  integrationBranch: string;
  mergeCommit: string | null;
  status: MergeStatus;
  conflictFiles: string[];
  createdAt: number;
}

/** A human-facing changelog entry, also persisted to the repo. */
export interface ChangelogEntry {
  id: string;
  projectId: string;
  ticketId: string | null;
  mergeId: string | null;
  entry: string;
  agentRole: string | null;
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
