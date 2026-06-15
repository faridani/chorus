import { z } from "zod";
import { runStructured, type StructuredRunOptions } from "./structured-run.js";

export interface EvaluatorVerdict {
  passed: boolean;
  failures: string[];
  diagnosis: string;
  evidence: string;
}

const EvaluatorZ = z.object({
  passed: z.boolean(),
  failures: z.array(z.string()).optional().default([]),
  diagnosis: z.string().optional().default(""),
  evidence: z.string().optional().default(""),
});

const EVALUATOR_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["passed", "failures", "diagnosis", "evidence"],
  properties: {
    passed: {
      type: "boolean",
      description:
        "true ONLY if every verify command succeeded AND the acceptance criteria are met. Otherwise false.",
    },
    failures: {
      type: "array",
      items: { type: "string" },
      description: "Each failing command or unmet acceptance criterion, one per entry.",
    },
    diagnosis: {
      type: "string",
      description:
        "Root-cause explanation of the failures and the SPECIFIC next change needed to fix them (passed verbatim to the next worker attempt). Empty if passed.",
    },
    evidence: {
      type: "string",
      description: "Key excerpts of command output proving pass/fail (truncated).",
    },
  },
} as const;

export interface EvaluatorArgs {
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
 * Run the evaluator agent: it runs the project's verify commands in the
 * worktree, checks the acceptance criteria, and returns a pass/fail verdict
 * with a diagnosis. Needs `workspace-write` so it can execute the commands.
 */
export function runEvaluator(args: EvaluatorArgs): Promise<EvaluatorVerdict> {
  return runStructured<EvaluatorVerdict>(
    "evaluator",
    { ...args, sandbox: "workspace-write" },
    EVALUATOR_JSON_SCHEMA,
    EvaluatorZ,
  );
}

export { EvaluatorZ, EVALUATOR_JSON_SCHEMA };
