import type { Project, Role, Ticket } from "@chorus/core";

const GLOBAL_GUARDRAILS = [
  "Work ONLY inside the current working directory (your isolated git worktree).",
  "NEVER run `git push`, and NEVER touch the `main` branch.",
  "Commit ALL of your changes with clear messages before you finish — uncommitted work is lost.",
  "Make the smallest change that fully satisfies the ticket; do not refactor unrelated code.",
  "If you genuinely cannot proceed, stop and report status `blocked` with the reason.",
];

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
