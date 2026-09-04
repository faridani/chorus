import type {
  AttemptJournalEntry,
  ChangelogEntry,
  Project,
  Ticket,
  TicketEvent,
} from "@chorus/core";
import { z } from "zod";
import { PROSE_NARRATION_RULE, READ_ONLY_RULE, runStructured } from "./structured-run.js";

export interface IdleTicketDraft {
  title: string;
  body: string;
}

export interface IdleTicketGenerationInput {
  project: Project;
  tickets: Ticket[];
  recentEvents: TicketEvent[];
  attemptJournal: AttemptJournalEntry[];
  changelog: ChangelogEntry[];
  specExcerpt: string | null;
  artifactsDir: string;
  bin?: string;
  model?: string;
  maxWallClockMs?: number;
  idleTimeoutMs?: number;
}

export type IdleTicketGenerator = (input: IdleTicketGenerationInput) => Promise<IdleTicketDraft>;

const IdleTicketDraftZ = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
});

export const IDLE_TICKET_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "body"],
  properties: {
    title: {
      type: "string",
      description: "Short imperative title for exactly one next ticket.",
    },
    body: {
      type: "string",
      description: "Markdown body with context, implementation guidance, and acceptance criteria.",
    },
  },
} as const;

export async function runIdleTicketGeneration(
  input: IdleTicketGenerationInput,
): Promise<IdleTicketDraft> {
  return runStructured<IdleTicketDraft>(
    "idle-ticket",
    {
      cwd: input.project.localPath,
      artifactsDir: input.artifactsDir,
      sandbox: "read-only",
      prompt: buildIdleTicketPrompt(input),
      bin: input.bin,
      model: input.model,
      maxWallClockMs: input.maxWallClockMs,
      idleTimeoutMs: input.idleTimeoutMs,
    },
    IDLE_TICKET_JSON_SCHEMA,
    IdleTicketDraftZ,
  );
}

export function buildIdleTicketPrompt(input: IdleTicketGenerationInput): string {
  const { project } = input;
  const L: string[] = [];
  L.push("# Generate the next Chorus ticket");
  L.push(
    "The active ticket queue is empty after prior work finished. Create exactly ONE priority-1 ticket that moves this project toward its product goal.",
  );
  L.push("");
  L.push("## Requirements");
  L.push("- Output exactly one ticket, not a list.");
  L.push("- Choose work that is useful now, grounded in the current repository state and project goal.");
  L.push("- Do not duplicate completed tickets or create broad, vague cleanup work.");
  L.push("- Keep it small enough for one engineering agent to complete in a focused run.");
  L.push("- Include concrete acceptance criteria in the body.");
  L.push("- Chorus will store the ticket with numeric priority 1; do not include priority in the JSON.");
  L.push("");
  L.push(READ_ONLY_RULE);
  L.push("");
  L.push("You are running in the repository checkout. Inspect source files if needed before deciding.");
  L.push("");
  L.push("## Project");
  L.push(`- Repository: ${project.repoUrl}`);
  L.push(`- Base branch: ${project.baseBranch}`);
  if (project.expectations?.trim()) L.push(`- Expectations: ${project.expectations.trim()}`);
  if (project.groundRules?.length) L.push(`- Ground rules: ${project.groundRules.join("; ")}`);
  if (project.setupCommand?.trim()) L.push(`- Setup command: ${project.setupCommand.trim()}`);
  if (project.verifyCommands?.length)
    L.push(`- Verify commands: ${project.verifyCommands.map((c) => `\`${c}\``).join(", ")}`);
  L.push("");

  if (input.specExcerpt?.trim()) {
    L.push("## Project Spec Excerpt");
    L.push(clip(input.specExcerpt, 6000));
    L.push("");
  }

  L.push("## Prior Tickets");
  if (input.tickets.length === 0) {
    L.push("- (none)");
  } else {
    for (const t of input.tickets.slice(0, 40)) {
      const body = t.body.trim() ? ` - ${clip(t.body, 280).replace(/\s+/g, " ")}` : "";
      L.push(
        `- [${t.status}] P${t.priority} ${t.title} (role: ${t.roleName ?? "unassigned"}, source: ${t.source})${body}`,
      );
    }
  }
  L.push("");

  L.push("## Recent Activity");
  if (input.recentEvents.length === 0) {
    L.push("- (none)");
  } else {
    for (const e of input.recentEvents.slice(0, 40)) {
      L.push(`- ${new Date(e.createdAt).toISOString()} [${e.actor} ${e.kind}] ${clip(e.message, 360)}`);
    }
  }
  L.push("");

  L.push("## Recent Attempt Journal");
  if (input.attemptJournal.length === 0) {
    L.push("- (none)");
  } else {
    for (const j of input.attemptJournal.slice(0, 25)) {
      const parts = [
        `ticket ${j.ticketId}`,
        `attempt ${j.attempt}`,
        `verify=${j.verifyPassed == null ? "not-run" : j.verifyPassed ? "passed" : "failed"}`,
      ];
      if (j.nextAction) parts.push(`next=${j.nextAction}`);
      if (j.diagnosis) parts.push(`diagnosis=${clip(j.diagnosis, 260)}`);
      if (j.proof) parts.push(`proof=${clip(j.proof, 180)}`);
      L.push(`- ${parts.join("; ")}`);
    }
  }
  L.push("");

  L.push("## Recent Changelog");
  if (input.changelog.length === 0) {
    L.push("- (none)");
  } else {
    for (const c of input.changelog.slice(0, 25)) {
      L.push(`- ${new Date(c.createdAt).toISOString()} ${clip(c.entry, 320)}`);
    }
  }
  L.push("");

  L.push("## Output");
  L.push("Return JSON with `title` and `body` only.");
  L.push(PROSE_NARRATION_RULE);
  return L.join("\n");
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(0, max - 20)).trimEnd()}\n[truncated]`;
}
