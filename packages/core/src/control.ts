import type { Project, Role, Ticket } from "./domain.js";
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
}

export type UpsertRoleInput = Omit<Role, "id" | "projectId">;

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

  addTicket(projectId: string, input: CreateTicketInput): Promise<Ticket>;
  updateTicket(projectId: string, ticketId: string, patch: UpdateTicketInput): Promise<Ticket>;
  deleteTicket(projectId: string, ticketId: string): Promise<void>;

  upsertRole(projectId: string, input: UpsertRoleInput): Promise<Role>;
  deleteRole(projectId: string, name: string): Promise<void>;

  startOrchestrator(): void;
  pauseOrchestrator(): void;
  stopOrchestrator(): Promise<void>;
  orchestratorState(): OrchestratorState;
  runningTaskIds(): string[];

  /** Human approval gate: merge the integration branch into main. */
  approveToMain(projectId: string): Promise<{ ok: boolean; message: string }>;
}
