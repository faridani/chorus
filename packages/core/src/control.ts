import type { BackendInfo } from "./backend-info.js";
import type { DiagnosisResult } from "./diagnostics.js";
import type { AgentTemplate, Project, ProjectRunState, Role, Ticket } from "./domain.js";
import type { OrchestratorState } from "./state.js";

export interface CreateProjectInput {
  repoUrl: string;
  /** Optional spec text to write if the repo has none. */
  specText?: string;
  /** Optional base branch; auto-detected from the repo when omitted. */
  baseBranch?: string;
}

export interface CreateTicketInput {
  title: string;
  body: string;
  roleName?: string;
  priority?: number;
  /** Filed from a Debug Traces diagnosis — records an audit trail entry. */
  fromDiagnostic?: boolean;
}

export interface UpdateTicketInput {
  title?: string;
  body?: string;
  roleName?: string;
  priority?: number;
  /** Set status back to "open" so the orchestrator re-dispatches it. */
  reopen?: boolean;
}

/**
 * One self-heal proposal: a concrete, machine-applicable change to an agent
 * definition or a project goal, derived from analyzing a ticket's traces.
 * Only the fields relevant to `kind` are populated (others are empty); the
 * controller interprets and applies them.
 */
export interface SelfHealProposal {
  /** Assigned server-side; stable within one analysis result. */
  id: string;
  kind: "role" | "expectations" | "ground_rules";
  /** Short label for the change. */
  title: string;
  /** Why this change, grounded in the observed traces. */
  rationale: string;
  /** For kind "role": the existing role to modify. */
  roleName?: string;
  /** role: new fields (empty = leave unchanged). */
  description?: string;
  allowed?: string[];
  forbidden?: string[];
  allowedToolIds?: string[];
  forbiddenToolIds?: string[];
  model?: string;
  /** expectations: the new project expectations text. */
  expectations?: string;
  /** ground_rules: the new project-wide ground rules. */
  groundRules?: string[];
}

export interface SelfHealResult {
  /** Human-readable diagnosis of what the traces show and the proposed direction. */
  summary: string;
  /** Proposed changes (empty when the agents look fine). */
  proposals: SelfHealProposal[];
}

export interface CleanupTicketsInput {
  /** Exact confirmation string required before destructive ticket cleanup. */
  confirmation: string;
  /** Close open GitHub pull requests associated with worked tickets. */
  removePullRequests?: boolean;
  /** Remove ticket worktrees plus local/remote branches associated with worked tickets. */
  removeBranches?: boolean;
}

export const TICKET_CLEANUP_CONFIRMATION = "DELETE";

export interface CleanupTicketsResult {
  deletedTickets: number;
  closedPullRequests: number;
  removedBranches: number;
}

export interface ProjectSettingsInput {
  baseBranch?: string;
  expectations?: string;
  groundRules?: string[];
  setupCommand?: string;
  verifyCommands?: string[];
  /** Enable auto-generating follow-up tickets when the queue drains. */
  idleIdeation?: boolean;
  /** Tickets to ideate per idle pass (clamped to 1–10). */
  idleIdeationCount?: number;
}

export type UpsertRoleInput = Omit<Role, "id" | "projectId">;

export type UpsertAgentTemplateInput = Omit<AgentTemplate, "id" | "createdAt">;

export interface ApplyAgentTemplateInput {
  /** Omitted means backward-compatible lookup: custom template first, then built-in. */
  source?: "custom" | "builtin";
  /** Template name, which becomes the project role name when applied. */
  name?: string;
  /** Stable built-in id. Custom templates are still addressed by name. */
  id?: string;
}

/**
 * Commands the web layer issues to the daemon. The daemon implements this;
 * the web layer reads state directly from the DB and calls these for any
 * mutation or lifecycle action. Keeps web → daemon one-directional (no cycle).
 */
export interface ControlApi {
  createProject(input: CreateProjectInput): Promise<Project>;
  /** Provide/refresh a spec for a project that had none, then (re)ingest. */
  provideSpec(projectId: string, specText: string): Promise<void>;
  /** Read the project's spec file (path + contents) from its checkout. */
  readProjectSpec(projectId: string): Promise<{ path: string | null; content: string | null }>;
  /** Update base branch / expectations / ground rules (applies going forward). */
  updateProjectSettings(projectId: string, patch: ProjectSettingsInput): Promise<Project>;
  /** Start / pause / stop dispatch for a single project independently. */
  setProjectRunState(projectId: string, state: ProjectRunState): Promise<Project>;

  addTicket(projectId: string, input: CreateTicketInput): Promise<Ticket>;
  updateTicket(projectId: string, ticketId: string, patch: UpdateTicketInput): Promise<Ticket>;
  /** Star / unstar a ticket. Display-only flag; allowed at any time. */
  setTicketStarred(projectId: string, ticketId: string, starred: boolean): Promise<Ticket>;
  /**
   * Launch an agent that studies the ticket's open-PR review comments, edits the
   * code to address the ones it agrees with, and posts a summary PR comment
   * (including reasons for any it disagrees with). Runs in the background.
   */
  addressPrComments(projectId: string, ticketId: string): Promise<{ started: boolean }>;
  /**
   * Analyze a ticket's messages/logs/traces and propose changes to the agent
   * definitions and project goals that would prevent the observed problems.
   * Read-only — returns proposals for the user to accept/reject.
   */
  selfHealAnalyze(projectId: string, ticketId: string, liveEvents: unknown[]): Promise<SelfHealResult>;
  /** Apply one accepted self-heal proposal (mutates a role or a project goal). */
  applySelfHealProposal(projectId: string, proposal: SelfHealProposal): Promise<void>;
  deleteTicket(projectId: string, ticketId: string): Promise<void>;
  /** Destructively remove every ticket in a project, with optional branch/PR cleanup. */
  cleanupTickets(projectId: string, input: CleanupTicketsInput): Promise<CleanupTicketsResult>;
  /** Reorder a project's tickets; `orderedIds` is top→bottom (top = highest priority). */
  reorderTickets(projectId: string, orderedIds: string[]): Promise<void>;

  upsertRole(projectId: string, input: UpsertRoleInput): Promise<Role>;
  deleteRole(projectId: string, name: string): Promise<void>;
  /** Create/update a project role from a gallery template, copying tool permissions. */
  applyTemplate(projectId: string, template: string | ApplyAgentTemplateInput): Promise<Role>;

  startOrchestrator(): void;
  pauseOrchestrator(): void;
  stopOrchestrator(): Promise<void>;
  orchestratorState(): OrchestratorState;
  runningTaskIds(): string[];
  /** Ticket ids currently being handled by the background "Address PR Reviews" action. */
  addressingPrTicketIds(): string[];

  /** Global "Agent Gallery" templates, reusable across projects. */
  upsertAgentTemplate(input: UpsertAgentTemplateInput): Promise<AgentTemplate>;
  deleteAgentTemplate(name: string): Promise<void>;

  /** Dismiss an orchestrator suggestion. */
  dismissSuggestion(projectId: string, suggestionId: string): Promise<void>;

  /**
   * Read-only "Debug Traces" diagnosis of recent activity. `ticketId` null =
   * project scope. `liveEvents` is the dashboard's client-buffered feed snapshot.
   */
  runDebugTraces(
    projectId: string,
    ticketId: string | null,
    liveEvents: unknown[],
  ): Promise<DiagnosisResult>;

  /** Backends/models detected on the host (for the Models panel + dropdowns). */
  listBackends(): BackendInfo[];
  /** Re-probe the host for backend CLIs/models (e.g. after installing one). */
  refreshBackends(): Promise<BackendInfo[]>;
}
