import { mkdirSync, readFileSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Project, newId, ORCHESTRATOR_ROLE, type Ticket } from "@chorus/core";
import type { ChorusDb } from "@chorus/db";
import { run } from "@chorus/proc";
import { z } from "zod";

const GeneratedTicketsSchema = z.object({
  tickets: z
    .array(
      z.object({
        title: z.string(),
        body: z.string(),
        roleName: z.string().optional(),
        priority: z.number().int().optional(),
      }),
    )
    .max(50),
});

const TICKETS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tickets"],
  properties: {
    tickets: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        // Strict structured output: every property must appear in `required`.
        required: ["title", "body", "roleName", "priority"],
        properties: {
          title: { type: "string", description: "Short imperative ticket title." },
          body: {
            type: "string",
            description: "What to build and the acceptance criteria, in markdown.",
          },
          roleName: { type: "string", description: "Suggested role, e.g. software-dev." },
          priority: { type: "number", description: "Higher = more important. 0 default." },
        },
      },
    },
  },
} as const;

export interface SpecIngestOptions {
  /** Override the codex binary (tests). */
  bin?: string;
  /** Working/artifacts dir for the generation run. */
  artifactsDir: string;
  timeoutMs?: number;
}

/**
 * Turns a project's spec into tickets using a one-shot, read-only Codex run
 * with a tickets-shaped output schema, then persists them as `open` tickets.
 */
export class SpecIngestor {
  constructor(private readonly db: ChorusDb) {}

  async ingest(project: Project, opts: SpecIngestOptions): Promise<Ticket[]> {
    if (!project.specPath) return [];
    const specText = readFileSync(join(project.localPath, project.specPath), "utf8");

    mkdirSync(opts.artifactsDir, { recursive: true });
    const schemaPath = join(opts.artifactsDir, "tickets-schema.json");
    const outputPath = join(opts.artifactsDir, "tickets.json");
    writeFileSync(schemaPath, JSON.stringify(TICKETS_JSON_SCHEMA, null, 2), "utf8");

    const prompt = buildIngestPrompt(specText);
    const r = await run(
      opts.bin ?? "codex",
      [
        "exec",
        "-s",
        "read-only",
        "--skip-git-repo-check",
        "-C",
        project.localPath,
        "--output-schema",
        schemaPath,
        "-o",
        outputPath,
        prompt,
      ],
      { timeoutMs: opts.timeoutMs ?? 10 * 60 * 1000 },
    );
    if (r.code !== 0) {
      throw new Error(`Ticket generation failed (${r.code}): ${r.stderr.slice(-500)}`);
    }

    const parsed = GeneratedTicketsSchema.safeParse(JSON.parse(readFileSync(outputPath, "utf8")));
    if (!parsed.success) {
      throw new Error("Ticket generation produced invalid output.");
    }

    const now = Date.now();
    const tickets: Ticket[] = parsed.data.tickets.map((t) => ({
      id: newId("tkt"),
      projectId: project.id,
      title: t.title,
      body: t.body,
      status: "open" as const,
      // Every ticket starts with the orchestrator agent, which triages + routes it.
      roleName: ORCHESTRATOR_ROLE,
      priority: t.priority ?? 0,
      source: "spec" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    }));
    for (const t of tickets) this.db.insertTicket(t);
    return tickets;
  }
}

function buildIngestPrompt(specText: string): string {
  return [
    "You are a senior engineer breaking a project specification into a set of small, independent, implementable tickets.",
    "Read the specification below and produce a prioritized list of tickets.",
    "Guidelines:",
    "- Each ticket should be completable by one engineer in a focused session.",
    "- Prefer vertical slices that deliver working functionality.",
    "- Order by priority (foundational work first, higher priority number = earlier).",
    "- Include clear acceptance criteria in each ticket body.",
    "- Do NOT write code now; only produce the tickets as the required JSON output.",
    "",
    "## Specification",
    specText.slice(0, 20000),
  ].join("\n");
}
