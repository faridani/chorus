import { z } from "zod";
import { runStructured, type StructuredRunOptions } from "./structured-run.js";

export interface ReviewerVerdict {
  approved: boolean;
  summary: string;
  risks: string[];
  rollback: string;
  uncertainties: string[];
}

const ReviewerZ = z.object({
  approved: z.boolean(),
  summary: z.string().optional().default(""),
  risks: z.array(z.string()).optional().default([]),
  rollback: z.string().optional().default(""),
  uncertainties: z.array(z.string()).optional().default([]),
});

const REVIEWER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["approved", "summary", "risks", "rollback", "uncertainties"],
  properties: {
    approved: {
      type: "boolean",
      description:
        "true if the diff correctly and completely satisfies the ticket's acceptance criteria and is safe to open as a PR. false if it is incomplete, incorrect, or risky.",
    },
    summary: { type: "string", description: "One-paragraph summary of what the change does, for the PR body." },
    risks: {
      type: "array",
      items: { type: "string" },
      description: "Concrete risks a reviewer/merger should know about.",
    },
    rollback: { type: "string", description: "How to safely revert this change if it misbehaves." },
    uncertainties: {
      type: "array",
      items: { type: "string" },
      description: "Things the agent is unsure about or could not verify.",
    },
  },
} as const;

export interface ReviewerArgs {
  cwd: string;
  artifactsDir: string;
  prompt: string;
  model?: string;
  maxWallClockMs?: number;
  idleTimeoutMs?: number;
  onEvent?: StructuredRunOptions["onEvent"];
  onStart?: StructuredRunOptions["onStart"];
}

/**
 * Run the reviewer agent: a read-only pass that judges the diff against the
 * acceptance criteria and reports approval plus risks/rollback/uncertainty for
 * the PR body.
 */
export function runReviewer(args: ReviewerArgs): Promise<ReviewerVerdict> {
  return runStructured<ReviewerVerdict>(
    "reviewer",
    { ...args, sandbox: "read-only" },
    REVIEWER_JSON_SCHEMA,
    ReviewerZ,
  );
}

export { ReviewerZ, REVIEWER_JSON_SCHEMA };
