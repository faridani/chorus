import type { Project, Role, Ticket, TicketEvent } from "@chorus/core";

const GLOBAL_GUARDRAILS = [
  "Work ONLY inside the current working directory (your isolated git worktree).",
  "NEVER run `git push`, and NEVER touch the `main` branch.",
  "Commit ALL of your changes with clear messages before you finish — uncommitted work is lost.",
  "Make the smallest change that fully satisfies the ticket; do not refactor unrelated code.",
  "If you genuinely cannot proceed, stop and report status `blocked` with the reason.",
];

/**
 * Render the orchestrator agent's triage/review prompt. It decides what happens
 * to one ticket using only the project's existing worker agents.
 */
export function buildOrchestratorPrompt(args: {
  project: Project;
  ticket: Ticket;
  trail: TicketEvent[];
  workers: Role[];
  /** Summary of work on the ticket branch (commits/files), or null if none yet. */
  workSummary: string | null;
  attempt: number;
  maxAttempts: number;
}): string {
  const { project, ticket, trail, workers, workSummary, attempt, maxAttempts } = args;
  const lines: string[] = [];
  lines.push("# You are the project ORCHESTRATOR agent");
  lines.push(
    "You triage one ticket and decide what happens next. You do not write code yourself.",
  );
  lines.push("");
  lines.push("## Project");
  lines.push(`Repository: ${project.repoUrl}`);
  if (project.expectations?.trim()) {
    lines.push("");
    lines.push("### High-level expectations");
    lines.push(project.expectations.trim());
  }
  if (project.groundRules?.length) {
    lines.push("");
    lines.push("### Ground rules");
    for (const g of project.groundRules) if (g.trim()) lines.push(`- ${g.trim()}`);
  }

  lines.push("");
  lines.push("## Ticket");
  lines.push(`Title: ${ticket.title}`);
  lines.push(`Priority: ${ticket.priority}`);
  lines.push("");
  lines.push(ticket.body);

  lines.push("");
  lines.push("## Work so far on this ticket");
  lines.push(workSummary ?? "No worker has produced any committed work yet.");
  lines.push(`Worker attempts so far: ${attempt} (max ${maxAttempts}).`);

  if (trail.length) {
    lines.push("");
    lines.push("## Activity trail (most recent last)");
    for (const e of trail.slice(-20)) {
      lines.push(`- [${e.actor} · ${e.kind}] ${e.message}`);
    }
  }

  lines.push("");
  lines.push("## Available worker agents (you may ONLY assign to these)");
  if (workers.length === 0) {
    lines.push("(none — if work is needed, suggest creating an appropriate agent instead)");
  } else {
    for (const w of workers) {
      lines.push(`- ${w.name}: ${w.description}`);
    }
  }

  lines.push("");
  lines.push("## Decide");
  lines.push("Choose exactly one action and return it as the required JSON:");
  lines.push("- assign: hand the ticket to one of the worker agents above (set `assignee` to its exact name). Use this when the ticket needs (more) implementation work.");
  lines.push("- merge: the committed work on the branch fully satisfies the ticket — merge it and close. Only use when there IS committed work and it's ready.");
  lines.push("- close: close the ticket without merging (e.g. nothing to do, duplicate, or obsolete).");
  lines.push("- needs_human: you cannot proceed (e.g. you need an agent that doesn't exist, or repeated attempts failed). Explain via `suggestions`.");
  lines.push("You may also create follow-up tickets (`newTickets`) and raise `suggestions` for the human. Never assign to an agent that isn't listed above.");

  return lines.join("\n");
}

/**
 * Render the full instruction set for an agent run: what the project is, the
 * agent's role and guardrails, the ticket, and how to report its result.
 */
export function buildAgentPrompt(args: {
  project: Project;
  role: Role | null;
  ticket: Ticket;
  specExcerpt: string | null;
  resume: boolean;
}): string {
  const { project, role, ticket, specExcerpt, resume } = args;
  const lines: string[] = [];

  lines.push("# Chorus agent task");
  lines.push("");
  lines.push("## Project");
  lines.push(`Repository: ${project.repoUrl}`);
  lines.push(`Integration branch (your work merges here): ${project.integrationBranch}`);
  if (project.expectations?.trim()) {
    lines.push("");
    lines.push("### High-level expectations");
    lines.push(project.expectations.trim());
  }
  if (specExcerpt) {
    lines.push("");
    lines.push("### Project specification (excerpt)");
    lines.push(specExcerpt.slice(0, 6000));
  }

  lines.push("");
  lines.push("## Your role");
  if (role) {
    lines.push(`You are the **${role.name}**. ${role.description}`);
    if (role.allowed.length) {
      lines.push("");
      lines.push("Allowed:");
      for (const a of role.allowed) lines.push(`- ${a}`);
    }
    if (role.forbidden.length) {
      lines.push("");
      lines.push("Forbidden:");
      for (const f of role.forbidden) lines.push(`- ${f}`);
    }
  } else {
    lines.push("You are a software engineer implementing the ticket below.");
  }

  lines.push("");
  lines.push("## Global guardrails");
  for (const g of GLOBAL_GUARDRAILS) lines.push(`- ${g}`);
  for (const g of project.groundRules ?? []) {
    if (g.trim()) lines.push(`- ${g.trim()}`);
  }

  lines.push("");
  lines.push("## Ticket");
  lines.push(`Title: ${ticket.title}`);
  lines.push("");
  lines.push(ticket.body);

  if (resume) {
    lines.push("");
    lines.push("## Resuming");
    lines.push(
      "This task was interrupted earlier. Inspect the current git state (committed and uncommitted) and continue from where it left off. Do not redo completed work.",
    );
  }

  lines.push("");
  lines.push("## When you finish");
  lines.push(
    "Commit your work, then return your final result as JSON matching the provided output schema: " +
      "`status` (success | no_changes | blocked), a one-paragraph `summary` for the changelog, and `filesChanged`.",
  );

  return lines.join("\n");
}
