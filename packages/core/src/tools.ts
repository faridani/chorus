import type { UpsertRoleInput } from "./control.js";
import type { AgentTemplate } from "./domain.js";

/**
 * The Chorus tool catalog: a source-owned, typed registry of capabilities an
 * agent can be granted or denied. These are permissions/documentation — most
 * are not yet directly callable by the model. `availability: "available"` marks
 * the ones the agent genuinely performs in its sandbox today (repo + verify);
 * everything else is `"planned"` (Chorus-mediated, not directly callable). Add
 * new tools by appending to TOOL_CATALOG; ids are stable and must not change.
 */
export type ToolCategory =
  | "tickets"
  | "activity"
  | "project"
  | "repo"
  | "verify"
  | "prs"
  | "notifications"
  | "security"
  | "memory";
export type ToolRisk = "low" | "medium" | "high";
export type ToolAvailability = "available" | "planned";

export interface ToolDef {
  /** Stable identifier (never coupled to display name). */
  id: string;
  name: string;
  category: ToolCategory;
  description: string;
  risk: ToolRisk;
  /** Whether using the tool mutates state outside the agent's reasoning. */
  sideEffects: boolean;
  availability: ToolAvailability;
  /** Short, prompt-facing note on how/when to use it. */
  usageNote: string;
}

export const TOOL_CATALOG: readonly ToolDef[] = [
  // tickets
  {
    id: "tickets.read",
    name: "Read tickets",
    category: "tickets",
    description: "Read project tickets, statuses, priorities, assignees, and ticket history.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Inspect tickets and their history for context.",
  },
  {
    id: "tickets.comment",
    name: "Comment on ticket",
    category: "tickets",
    description: "Add a note/activity entry to a ticket without changing its lifecycle state.",
    risk: "low",
    sideEffects: true,
    availability: "planned",
    usageNote: "Record a note on a ticket; does not change its state.",
  },
  {
    id: "tickets.suggest",
    name: "Raise suggestion",
    category: "tickets",
    description: "Create a human-visible suggestion tied to a project or ticket.",
    risk: "low",
    sideEffects: true,
    availability: "planned",
    usageNote: "Surface a recommendation for the human to review.",
  },
  {
    id: "tickets.create",
    name: "Create ticket",
    category: "tickets",
    description: "Create a follow-up ticket.",
    risk: "medium",
    sideEffects: true,
    availability: "planned",
    usageNote: "Propose follow-up work as a new ticket.",
  },
  {
    id: "tickets.update",
    name: "Update ticket",
    category: "tickets",
    description: "Edit ticket title, body, priority, or assignee.",
    risk: "medium",
    sideEffects: true,
    availability: "planned",
    usageNote: "Modify ticket fields.",
  },
  {
    id: "tickets.transition.request",
    name: "Request ticket transition",
    category: "tickets",
    description:
      "Request a ticket transition such as blocked, review, closed, or reopened; mediated by the orchestrator.",
    risk: "medium",
    sideEffects: true,
    availability: "planned",
    usageNote: "Ask the orchestrator to move a ticket's lifecycle state.",
  },
  // activity
  {
    id: "activity.emit",
    name: "Emit activity",
    category: "activity",
    description: "Send a short live activity message to the dashboard feed.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Post a brief progress message to the live feed.",
  },
  // project
  {
    id: "project.context.read",
    name: "Read project context",
    category: "project",
    description:
      "Read project settings, spec path, expectations, ground rules, setup command, and verify commands.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Consult project-level configuration and intent.",
  },
  // repo (genuinely available in the agent's sandbox)
  {
    id: "repo.read",
    name: "Read repository",
    category: "repo",
    description: "Inspect repository files and git state in the assigned worktree.",
    risk: "low",
    sideEffects: false,
    availability: "available",
    usageNote: "Read files and inspect git state in your worktree.",
  },
  {
    id: "repo.modify",
    name: "Modify repository",
    category: "repo",
    description: "Modify files in the assigned worktree.",
    risk: "medium",
    sideEffects: true,
    availability: "available",
    usageNote: "Edit/create files in your worktree.",
  },
  {
    id: "repo.commit",
    name: "Commit changes",
    category: "repo",
    description: "Commit changes on the assigned branch.",
    risk: "medium",
    sideEffects: true,
    availability: "available",
    usageNote: "Commit your work on the ticket branch (never push).",
  },
  // verify
  {
    id: "verify.run",
    name: "Run verification",
    category: "verify",
    description: "Run configured project verification commands.",
    risk: "low",
    sideEffects: true,
    availability: "available",
    usageNote: "Run the project's verify commands (build/test/lint).",
  },
  // prs
  {
    id: "prs.read",
    name: "Read PRs",
    category: "prs",
    description: "Read PR metadata associated with a ticket.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Inspect the PR linked to a ticket.",
  },
  {
    id: "prs.comments.read",
    name: "Read PR comments",
    category: "prs",
    description: "Read PR review comments and discussion.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Read review discussion on a PR.",
  },
  {
    id: "prs.open.request",
    name: "Request PR open",
    category: "prs",
    description: "Request that Chorus open a PR after verification passes.",
    risk: "medium",
    sideEffects: true,
    availability: "planned",
    usageNote: "Ask Chorus to open a PR once the work verifies.",
  },
  // notifications
  {
    id: "notifications.suggest_imessage",
    name: "Draft iMessage",
    category: "notifications",
    description: "Draft an iMessage notification for human approval, not send directly.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Draft (do not send) an iMessage for human approval.",
  },
  // security
  {
    id: "security.report",
    name: "Report security finding",
    category: "security",
    description: "File a security finding as a ticket or suggestion without changing code.",
    risk: "medium",
    sideEffects: true,
    availability: "planned",
    usageNote: "Report a vulnerability as a ticket/suggestion; do not change code.",
  },
  // memory
  {
    id: "changelog.read",
    name: "Read changelog",
    category: "memory",
    description: "Read changelog entries.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Read the project changelog.",
  },
  {
    id: "attempt_journal.read",
    name: "Read attempt journal",
    category: "memory",
    description: "Read prior attempt journal entries for the current ticket.",
    risk: "low",
    sideEffects: false,
    availability: "planned",
    usageNote: "Review prior attempts' diagnoses and proofs for this ticket.",
  },
  {
    id: "attempt_journal.write",
    name: "Write attempt journal",
    category: "memory",
    description: "Write structured diagnosis/proof/next-action notes for the current attempt.",
    risk: "low",
    sideEffects: true,
    availability: "planned",
    usageNote: "Record structured diagnosis/proof/next-action for this attempt.",
  },
];

export const TOOL_IDS: ReadonlySet<string> = new Set(TOOL_CATALOG.map((t) => t.id));

export function getTool(id: string): ToolDef | undefined {
  return TOOL_CATALOG.find((t) => t.id === id);
}

/**
 * Validate a tool selection: every id must exist in the catalog, and no id may
 * be both allowed and forbidden. Pure + synchronous so it's trivially testable
 * and callable from the controller before persisting.
 */
export function validateToolSelection(
  allowed: string[],
  forbidden: string[],
): { ok: true } | { ok: false; error: string } {
  for (const id of [...allowed, ...forbidden]) {
    if (!TOOL_IDS.has(id)) return { ok: false, error: `Unknown tool id: ${id}` };
  }
  const allowedSet = new Set(allowed);
  const overlap = forbidden.find((id) => allowedSet.has(id));
  if (overlap) return { ok: false, error: `Tool id is both allowed and forbidden: ${overlap}` };
  return { ok: true };
}

// ---- default safe postures (seeded into the built-in roles for new projects) ----

/** Read-mostly baseline every agent gets. */
export const BASE_TOOLS: string[] = [
  "tickets.read",
  "activity.emit",
  "project.context.read",
  "repo.read",
  "attempt_journal.read",
];

/** Coding agents additionally edit/commit/verify and journal their attempts. */
export const CODING_TOOLS: string[] = [
  ...BASE_TOOLS,
  "repo.modify",
  "repo.commit",
  "verify.run",
  "attempt_journal.write",
];

/** Orchestrator-like agents route work and mediate transitions/PRs (no code writes). */
export const ORCHESTRATOR_TOOLS: string[] = [
  "tickets.read",
  "tickets.create",
  "tickets.suggest",
  "tickets.transition.request",
  "prs.read",
  "prs.open.request",
  "activity.emit",
  "project.context.read",
  "changelog.read",
  "attempt_journal.read",
];

/**
 * Build the role input from a gallery template, copying tool permissions too.
 * Pure + testable; used by the controller's applyTemplate.
 */
export function templateToRoleInput(t: AgentTemplate): UpsertRoleInput {
  return {
    name: t.name,
    description: t.description,
    allowed: [...t.allowed],
    forbidden: [...t.forbidden],
    allowedToolIds: [...t.allowedToolIds],
    forbiddenToolIds: [...t.forbiddenToolIds],
    backendId: t.backendId,
    model: t.model,
  };
}
