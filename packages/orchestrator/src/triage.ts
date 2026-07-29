import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapCodexLine } from "@chorus/backends";
import type { AgentEvent, OrchestratorDecision } from "@chorus/core";
import { StreamingProcess } from "@chorus/proc";
import { z } from "zod";

const DecisionZ = z.object({
  action: z.enum(["assign", "merge", "close", "needs_human"]),
  assignee: z.string().optional().default(""),
  priority: z.number().optional(),
  newTickets: z
    .array(
      z.object({
        title: z.string(),
        body: z.string(),
        priority: z.number().optional(),
      }),
    )
    .optional()
    .default([]),
  suggestions: z.array(z.string()).optional().default([]),
  message: z.string(),
});

// Strict JSON Schema (every property required, additionalProperties:false) as the
// model provider's structured-output mode demands.
const DECISION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["action", "assignee", "priority", "newTickets", "suggestions", "message"],
  properties: {
    action: {
      type: "string",
      enum: ["assign", "merge", "close", "needs_human"],
      description:
        "assign = hand the ticket to a worker agent; merge = the work on the branch is ready, merge it and close; close = close the ticket with no merge; needs_human = stop and ask the human.",
    },
    assignee: {
      type: "string",
      description: "For action=assign, the exact name of an existing project worker agent. Else empty string.",
    },
    priority: { type: "number", description: "New priority for the ticket (use the current one if unchanged)." },
    newTickets: {
      type: "array",
      description: "Follow-up tickets to create (each is assigned to the orchestrator for triage).",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "body", "priority"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          priority: { type: "number" },
        },
      },
    },
    suggestions: {
      type: "array",
      items: { type: "string" },
      description: "Messages to the human, e.g. 'Create a Security agent to check for vulnerabilities'.",
    },
    message: { type: "string", description: "One sentence explaining the decision (recorded in the ticket trail)." },
  },
} as const;

export interface TriageOptions {
  /** Working directory: the ticket's worktree if it exists, else the project clone. */
  cwd: string;
  artifactsDir: string;
  prompt: string;
  bin?: string;
  model?: string;
  maxWallClockMs?: number;
  idleTimeoutMs?: number;
  /** Streamed normalized events (the orchestrator's reasoning/commands) for the live feed. */
  onEvent?: (event: AgentEvent) => void;
}

/**
 * Run the orchestrator agent (read-only) to produce a structured decision,
 * streaming its reasoning/commands to `onEvent` as they happen (so the live
 * feed shows the orchestrator "thinking" instead of going silent).
 */
export async function runTriage(opts: TriageOptions): Promise<OrchestratorDecision> {
  mkdirSync(opts.artifactsDir, { recursive: true });
  const schemaPath = join(opts.artifactsDir, "decision-schema.json");
  const outputPath = join(opts.artifactsDir, "decision.json");
  const rawLogPath = join(opts.artifactsDir, "raw.log");
  writeFileSync(schemaPath, JSON.stringify(DECISION_JSON_SCHEMA, null, 2), "utf8");

  const proc = new StreamingProcess(
    opts.bin ?? "codex",
    [
      "exec",
      "--json",
      "-s",
      "read-only",
      "--skip-git-repo-check",
      "-C",
      opts.cwd,
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      ...(opts.model ? ["-m", opts.model] : []),
      opts.prompt,
    ],
    {
      cwd: opts.cwd,
      rawLogPath,
      maxWallClockMs: opts.maxWallClockMs ?? 10 * 60 * 1000,
      idleTimeoutMs: opts.idleTimeoutMs,
    },
  );
  if (opts.onEvent) {
    proc.onLine((line) => {
      for (const ev of mapCodexLine(line, opts.cwd)) opts.onEvent!(ev);
    });
  }

  const exit = await proc.exit;
  if (exit.code !== 0) {
    throw new Error(`Orchestrator triage failed (${exit.code}): ${exit.stderrTail.slice(-500)}`);
  }
  const parsed = DecisionZ.safeParse(JSON.parse(readFileSync(outputPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`Orchestrator triage produced invalid output: ${parsed.error.message}`);
  }
  return parsed.data;
}

export { DecisionZ, DECISION_JSON_SCHEMA };
