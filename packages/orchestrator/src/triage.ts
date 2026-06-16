import type { AgentEvent, OrchestratorDecision } from "@chorus/core";
import { z } from "zod";
import { runStructured } from "./structured-run.js";

const DecisionZ = z.object({
  action: z.enum(["assign", "open_pr", "close", "needs_human"]),
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
      enum: ["assign", "open_pr", "close", "needs_human"],
      description:
        "assign = hand the ticket to a worker agent; open_pr = the work on the branch is ready, push it and open a GitHub PR against the base branch; close = close the ticket with no PR; needs_human = stop and ask the human.",
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
  /** Receives a stop fn once the process starts, so callers can cancel it. */
  onStart?: (stop: () => Promise<void>) => void;
}

/**
 * Run the orchestrator agent (read-only) to produce a structured decision,
 * streaming its reasoning/commands to `onEvent` as they happen (so the live
 * feed shows the orchestrator "thinking" instead of going silent).
 *
 * Delegates to the shared `runStructured` so triage gets the same hardening as
 * the evaluator/reviewer: the `-o` file is authoritative on a natural exit (incl.
 * non-zero "crashed", where codex writes the result then exits non-zero), an
 * interruption (killed/timeout) is NOT mistaken for a real decision, and raw-JSON
 * agent messages (e.g. premature "needs_human" emissions) are kept out of the feed.
 */
export async function runTriage(opts: TriageOptions): Promise<OrchestratorDecision> {
  return runStructured<OrchestratorDecision>(
    "decision",
    { ...opts, sandbox: "read-only" },
    DECISION_JSON_SCHEMA,
    DecisionZ,
  );
}

export { DecisionZ, DECISION_JSON_SCHEMA };
