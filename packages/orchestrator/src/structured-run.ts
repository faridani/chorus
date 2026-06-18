import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mapCodexLine } from "@chorus/backends";
import type { AgentEvent } from "@chorus/core";
import { StreamingProcess } from "@chorus/proc";
import type { z } from "zod";

/**
 * Appended to structured-output prompts so the model narrates progress as prose
 * instead of repeatedly emitting the result schema (which floods the live feed
 * with fake interim verdicts and can be mistaken for the real result).
 */
export const PROSE_NARRATION_RULE =
  "Narrate your reasoning and progress in plain prose. Emit the required JSON object EXACTLY ONCE — as your final message — never as interim 'in progress' updates.";

/**
 * Appended to read-only agents' prompts. They run in a `read-only` sandbox, so
 * build/test/install commands fail on write-denial (e.g. test suites that
 * mkdtemp). Without this, an agent that "verifies by running the tests" sees a
 * sandbox failure and mis-reads it as a real test failure (hallucinated bug /
 * wasted reassign loops). Chorus runs verification separately and authoritatively.
 */
export const READ_ONLY_RULE =
  "You run in a READ-ONLY sandbox: you may read files and run read-only commands (e.g. `git diff`, `git log`, `cat`), but you CANNOT write files or run build/test/install commands such as `npm install`, `npm run build`, or `npm test` — they FAIL on sandbox write-denial, NOT because anything is broken. Do NOT attempt them. Chorus runs verification separately; treat its results as authoritative and base your judgment on the diff, the work summary, and the trail.";

/**
 * Appended to evaluator/reviewer prompts. Keeps judgments grounded in the diff +
 * authoritative verify output and time-bounded, WITHOUT discouraging dependency
 * investigation that an acceptance criterion genuinely depends on (e.g. checking
 * a CLI's required flags). Exhaustive line-by-line audits of third-party/
 * node_modules internals are slow and risk the idle timeout killing the run.
 */
export const EVIDENCE_SCOPE_RULE =
  "Base your judgment primarily on the committed diff, the ticket's acceptance criteria, and the authoritative verify output. You MAY inspect external/dependency behavior (a CLI's flags, a library's docs) when an acceptance criterion genuinely depends on it — but do so purposefully and stop once you have the answer. Do NOT exhaustively audit third-party or node_modules internals line-by-line when the diff already settles the question; long inspections risk being interrupted before you can report.";

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
      for (const ev of mapCodexLine(line, opts.cwd)) {
        // Structured runs emit their AUTHORITATIVE result via the `-o` file, but
        // codex ALSO streams schema-shaped JSON as agent messages — including
        // premature "in progress" / "commentary channel constrained" emissions
        // that flood the live feed and can look like a real verdict. Drop those
        // raw-JSON message events; prose narration (and the recorded result via
        // the output file) are unaffected. (events.ts already turns JSON with a
        // `summary` field into prose, so only summary-less raw JSON is dropped.)
        if (ev.kind === "message" && looksLikeJsonObject(ev.text)) continue;
        opts.onEvent!(ev);
      }
    });
  }

  const exit = await proc.exit;
  // On INTERRUPTION (we killed it, or it hit a wall/idle timeout) the `-o` file may
  // hold a PREMATURE emission the model wrote mid-inspection — not its final
  // verdict. Trusting it would turn an interruption into a false rejection (and
  // redo passing work), so only read the output file when the process ended on
  // its own. A natural exit — even a non-zero "crashed" (codex commonly writes the
  // final result then exits non-zero) — is authoritative regardless of exit code.
  if (exit.outcome === "killed" || exit.outcome === "timeout" || exit.outcome === "idle_timeout") {
    throw new Error(
      `${label} run interrupted (${exit.outcome}, code=${exit.code}); ${cleanStderr(exit.stderrTail)}`,
    );
  }
  const result = parseStructuredOutput(outputPath, zodSchema);
  if (result.ok) return result.data;

  throw new Error(
    `${label} run failed (${exit.outcome}, code=${exit.code}): ${result.error}; ${cleanStderr(exit.stderrTail)}`,
  );
}

/** True if `text` is a JSON object literal (a structured emission, not prose). */
export function looksLikeJsonObject(text: unknown): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const v = JSON.parse(t);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
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
