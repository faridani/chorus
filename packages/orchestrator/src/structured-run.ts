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
  // Prefer the structured output file: codex commonly writes the final result and
  // then exits non-zero or lingers until we kill it. A valid result is success
  // regardless of exit code — discarding it caused spurious evaluator/reviewer
  // failures. Only when there's no usable output do we report a real failure.
  const result = parseStructuredOutput(outputPath, zodSchema);
  if (result.ok) return result.data;

  throw new Error(
    `${label} run failed (${exit.outcome}, code=${exit.code}): ${result.error}; ${cleanStderr(exit.stderrTail)}`,
  );
}

/** Codex prints this benign banner on every run; it is not a failure cause. */
const BENIGN_STDERR = /reading additional input from stdin/i;

function cleanStderr(tail: string): string {
  const filtered = tail
    .split("\n")
    .filter((l) => l.trim() && !BENIGN_STDERR.test(l))
    .join("\n")
    .slice(-500);
  return filtered || "(no error output)";
}

/** Read + Zod-validate the `-o` output file. Never throws. */
export function parseStructuredOutput<T>(
  outputPath: string,
  zodSchema: z.ZodType<T, z.ZodTypeDef, any>,
): { ok: true; data: T } | { ok: false; error: string } {
  let raw: string;
  try {
    raw = readFileSync(outputPath, "utf8");
  } catch {
    return { ok: false, error: "no output file produced" };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `output is not valid JSON: ${String(e)}` };
  }
  const parsed = zodSchema.safeParse(json);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, error: `output failed schema validation: ${parsed.error.message}` };
}
