import type { BackendInfo } from "./backend-info.js";
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
}

export type UpsertRoleInput = Omit<Role, "id" | "projectId">;

export type UpsertAgentTemplateInput = Omit<AgentTemplate, "id" | "createdAt">;

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
  deleteTicket(projectId: string, ticketId: string): Promise<void>;
  /** Reorder a project's tickets; `orderedIds` is top→bottom (top = highest priority). */
  reorderTickets(projectId: string, orderedIds: string[]): Promise<void>;

  upsertRole(projectId: string, input: UpsertRoleInput): Promise<Role>;
  deleteRole(projectId: string, name: string): Promise<void>;
  /** Create/update a project role from a gallery template, copying tool permissions. */
  applyTemplate(projectId: string, templateName: string): Promise<Role>;

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

  /** Backends/models detected on the host (for the Models panel + dropdowns). */
  listBackends(): BackendInfo[];
  /** Re-probe the host for backend CLIs/models (e.g. after installing one). */
  refreshBackends(): Promise<BackendInfo[]>;
}
