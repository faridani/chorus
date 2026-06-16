import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentEvent,
  type AgentResult,
  AgentResultPayloadSchema,
  type AgentRunHandle,
  type AgentRunSpec,
  type AIBackend,
  type BackendCapabilities,
  type ExitContext,
  type QuotaPolicy,
  type UsageCounters,
} from "@chorus/core";
import { StreamingProcess } from "@chorus/proc";
import { AsyncQueue } from "../async-queue.js";
import { runCliUpdate } from "../cli-update.js";
import { mapCodexLine } from "./events.js";
import { CODEX_OUTPUT_SCHEMA } from "./result-schema.js";

export interface CodexBackendOptions {
  quotaPolicy: QuotaPolicy;
  /** Default model (empty → CLI default). */
  defaultModel?: string;
  /** Reasoning summary verbosity: auto | concise | detailed | none. */
  reasoningSummary?: string;
  /** Override the binary (tests). */
  bin?: string;
  /** Self-update the CLI once per process before first use (default true). */
  autoUpdate?: boolean;
}

/**
 * Drives the Codex CLI in non-interactive mode. Each run executes in an
 * isolated git worktree with full sandbox access; the structured output FILE
 * (not the event stream) is the authoritative result.
 */
export class CodexBackend implements AIBackend {
  readonly id = "codex";
  readonly capabilities: BackendCapabilities = {
    structuredOutput: true,
    usageEvents: true,
    resume: false, // we resume by re-running in the same worktree, not via CLI session
  };

  private prepared?: Promise<string | null>;

  constructor(private readonly opts: CodexBackendOptions) {}

  prepare(): Promise<string | null> {
    if (this.opts.autoUpdate === false) return Promise.resolve(null);
    // Codex has no `codex update` subcommand; update via the npm global package.
    this.prepared ??= runCliUpdate("npm", ["install", "-g", "@openai/codex@latest"], "codex", 180_000);
    return this.prepared;
  }

  startRun(spec: AgentRunSpec): AgentRunHandle {
    mkdirSync(spec.artifactsDir, { recursive: true });
    const schemaPath = join(spec.artifactsDir, "schema.json");
    const outputPath = join(spec.artifactsDir, "result.json");
    const rawLogPath = join(spec.artifactsDir, "raw.log");
    writeFileSync(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA, null, 2), "utf8");

    const queue = new AsyncQueue<AgentEvent>();
    const lastEvents: AgentEvent[] = [];
    let usage: UsageCounters = {};
    let killedByUs = false;

    const model = spec.model ?? this.opts.defaultModel;
    const reasoning = this.opts.reasoningSummary ?? "auto";
    const args = [
      "exec",
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      // Stream the model's reasoning summary so the dashboard can show it.
      ...(reasoning !== "none" ? ["-c", `model_reasoning_summary=${reasoning}`] : []),
      "-C",
      spec.worktreePath,
      "--output-schema",
      schemaPath,
      "-o",
      outputPath,
      ...(model ? ["-m", model] : []),
      spec.prompt,
    ];

    const proc = new StreamingProcess(this.opts.bin ?? "codex", args, {
      cwd: spec.worktreePath,
      rawLogPath,
      maxWallClockMs: spec.maxWallClockMs,
      idleTimeoutMs: spec.idleTimeoutMs,
    });

    proc.onLine((line) => {
      for (const ev of mapCodexLine(line, spec.worktreePath)) {
        if (ev.kind === "usage") usage = mergeUsage(usage, ev.usage);
        lastEvents.push(ev);
        if (lastEvents.length > 20) lastEvents.shift();
        queue.push(ev);
      }
    });

    const result: Promise<AgentResult> = (async () => {
      // Always close the event queue, even if result-processing throws —
      // otherwise a consumer iterating `events` would hang forever.
      try {
        const exit = await proc.exit;

        const ctx: ExitContext = {
          exitCode: exit.code,
          signal: exit.signal,
          stderrTail: exit.stderrTail,
          lastEvents: [...lastEvents],
          killedByUs,
        };
        let terminalReason =
          exit.outcome === "timeout" || exit.outcome === "idle_timeout"
            ? exit.outcome
            : this.opts.quotaPolicy.classifyExit(ctx);
        if (killedByUs) terminalReason = "killed";

        return {
          payload: readPayload(outputPath),
          exitCode: exit.code,
          signal: exit.signal,
          terminalReason,
          usage,
          rawLogPath,
          outputFilePath: outputPath,
        } satisfies AgentResult;
      } finally {
        queue.close();
      }
    })();

    return {
      pid: proc.pid,
      pgid: proc.pgid,
      events: queue,
      result,
      stop: async () => {
        killedByUs = true;
        await proc.stop();
      },
    };
  }
}

function readPayload(path: string) {
  try {
    const text = readFileSync(path, "utf8");
    const parsed = AgentResultPayloadSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function mergeUsage(a: UsageCounters, b: UsageCounters): UsageCounters {
  return {
    inputTokens: pickMax(a.inputTokens, b.inputTokens),
    outputTokens: pickMax(a.outputTokens, b.outputTokens),
    totalTokens: pickMax(a.totalTokens, b.totalTokens),
    raw: b.raw ?? a.raw,
  };
}

// Codex usage events are typically cumulative; keep the max seen.
function pickMax(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
