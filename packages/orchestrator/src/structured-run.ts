import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapCodexLine } from "@chorus/backends";
import type { AgentEvent } from "@chorus/core";
import { StreamingProcess } from "@chorus/proc";
import type { z } from "zod";

export interface StructuredRunOptions {
  /** Working directory (the ticket's worktree). */
  cwd: string;
  /** Where schema/output/raw-log artifacts are written. */
  artifactsDir: string;
  /** Sandbox mode: read-only for review, workspace-write so the evaluator can run commands. */
  sandbox: "read-only" | "workspace-write";
  prompt: string;
  bin?: string;
  model?: string;
  maxWallClockMs?: number;
  idleTimeoutMs?: number;
  /** Streamed normalized events for the live feed. */
  onEvent?: (event: AgentEvent) => void;
  /** Receives a stop fn once the process starts, so callers can cancel it. */
  onStart?: (stop: () => Promise<void>) => void;
}

/**
 * Run a Codex agent that must emit a single structured JSON result validated
 * against `schema`. The same machinery as `runTriage` (codex exec --json
 * --output-schema -o out.json, streamed + Zod-validated), generalized so the
 * evaluator and reviewer passes reuse it. Throws on non-zero exit or invalid
 * output (callers decide how to treat the failure).
 */
export async function runStructured<T>(
  label: string,
  opts: StructuredRunOptions,
  jsonSchema: unknown,
  // Input type intentionally `any`: these schemas use .default(), so the parsed
  // input shape differs from the output T.
  zodSchema: z.ZodType<T, z.ZodTypeDef, any>,
): Promise<T> {
  mkdirSync(opts.artifactsDir, { recursive: true });
  const schemaPath = join(opts.artifactsDir, `${label}-schema.json`);
  const outputPath = join(opts.artifactsDir, `${label}.json`);
  const rawLogPath = join(opts.artifactsDir, `${label}.log`);
  writeFileSync(schemaPath, JSON.stringify(jsonSchema, null, 2), "utf8");

  const proc = new StreamingProcess(
    opts.bin ?? "codex",
    [
      "exec",
      "--json",
      "-s",
      opts.sandbox,
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
      maxWallClockMs: opts.maxWallClockMs ?? 15 * 60 * 1000,
      idleTimeoutMs: opts.idleTimeoutMs,
    },
  );
  opts.onStart?.(() => proc.stop());
  if (opts.onEvent) {
    proc.onLine((line) => {
      for (const ev of mapCodexLine(line, opts.cwd)) opts.onEvent!(ev);
    });
  }

  const exit = await proc.exit;
  if (exit.code !== 0) {
    throw new Error(`${label} run failed (${exit.code}): ${exit.stderrTail.slice(-500)}`);
  }
  const parsed = zodSchema.safeParse(JSON.parse(readFileSync(outputPath, "utf8")));
  if (!parsed.success) {
    throw new Error(`${label} produced invalid output: ${parsed.error.message}`);
  }
  return parsed.data;
}
