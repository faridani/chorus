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
  /** Update base branch / expectations / ground rules (applies going forward). */
  updateProjectSettings(projectId: string, patch: ProjectSettingsInput): Promise<Project>;
  /** Start / pause / stop dispatch for a single project independently. */
  setProjectRunState(projectId: string, state: ProjectRunState): Promise<Project>;

  addTicket(projectId: string, input: CreateTicketInput): Promise<Ticket>;
  updateTicket(projectId: string, ticketId: string, patch: UpdateTicketInput): Promise<Ticket>;
  /** Star / unstar a ticket. Display-only flag; allowed at any time. */
  setTicketStarred(projectId: string, ticketId: string, starred: boolean): Promise<Ticket>;
  deleteTicket(projectId: string, ticketId: string): Promise<void>;
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
