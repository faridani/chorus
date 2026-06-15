import { z } from "zod";
import type { TerminalReason } from "./state.js";

/**
 * The contract a backend CLI's final structured output must satisfy. We pass
 * this (as JSON Schema) to `codex exec --output-schema` and validate the
 * resulting file with this Zod schema. The output FILE — not the event
 * stream — is the authoritative result.
 */
export const AgentResultPayloadSchema = z.object({
  status: z.enum(["success", "blocked", "no_changes"]),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  notes: z.string().optional(),
});
export type AgentResultPayload = z.infer<typeof AgentResultPayloadSchema>;

/** Token/usage counters normalized across backends (best-effort). */
export interface UsageCounters {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Raw, backend-specific usage blob for forensics. */
  raw?: unknown;
}

/**
 * Normalized streaming event. Each backend adapter translates its native
 * JSONL into this union so the orchestrator never sees Codex-specific shapes.
 */
export type AgentEvent =
  | { kind: "progress"; message: string; at: number }
  | { kind: "tool_use"; tool: string; detail?: string; at: number }
  | { kind: "usage"; usage: UsageCounters; at: number }
  | { kind: "log"; line: string; at: number }
  | { kind: "quota_warning"; message: string; at: number };

/** What the orchestrator hands a backend to start a run. */
export interface AgentRunSpec {
  taskId: string;
  /** Fully-rendered prompt: project context + role + guardrails + ticket. */
  prompt: string;
  /** Absolute path to the git worktree the agent must work in. */
  worktreePath: string;
  /** Optional model override (backend default otherwise). */
  model?: string;
  /** True when re-running in an existing worktree to continue prior work. */
  resume?: boolean;
  /** Hard wall-clock cap in ms. */
  maxWallClockMs?: number;
  /** Kill if no event arrives within this many ms. */
  idleTimeoutMs?: number;
  /** Directory where raw logs + the output file should be written. */
  artifactsDir: string;
}

/** The authoritative result of a finished run. */
export interface AgentResult {
  /** Parsed + validated structured output, or null if missing/invalid. */
  payload: AgentResultPayload | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  terminalReason: TerminalReason;
  usage: UsageCounters;
  /** Path to the persisted raw stdout/stderr log for this run. */
  rawLogPath: string;
  /** Path to the structured output file (may not exist). */
  outputFilePath: string;
}

/** A handle to a live run. */
export interface AgentRunHandle {
  /** OS process id of the spawned CLI (for diagnostics). */
  readonly pid: number | undefined;
  /** Process-group id, used for group-kill. */
  readonly pgid: number | undefined;
  /** Normalized event stream; completes when the process exits. */
  readonly events: AsyncIterable<AgentEvent>;
  /** Resolves once the process has fully exited and output is read. */
  readonly result: Promise<AgentResult>;
  /** Graceful stop (SIGTERM group → grace → SIGKILL). */
  stop(reason: "killed"): Promise<void>;
}

export interface BackendCapabilities {
  /** Supports a machine-checked structured final output. */
  structuredOutput: boolean;
  /** Emits token/usage events we can track. */
  usageEvents: boolean;
  /** Can resume a prior session natively (vs. re-running in the worktree). */
  resume: boolean;
}

/** The plug for any subscription CLI (Codex now; Claude/Gemini later). */
export interface AIBackend {
  readonly id: string;
  readonly capabilities: BackendCapabilities;
  startRun(spec: AgentRunSpec): AgentRunHandle;
}

/** Inputs available when classifying how a run ended. */
export interface ExitContext {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Tail of stderr (quota/auth errors usually land here). */
  stderrTail: string;
  /** The last few normalized events seen before exit. */
  lastEvents: AgentEvent[];
  /** True if we deliberately killed the process. */
  killedByUs: boolean;
}

/**
 * Per-backend, config-tunable classifier for how a run ended and when to
 * retry after a quota pause. Regexes live in config so we can tune without a
 * release once we learn the real CLI wording.
 */
export interface QuotaPolicy {
  classifyExit(ctx: ExitContext): TerminalReason;
  /** When to attempt resume after a quota_exhausted result. */
  nextRetryAt(now: number, consecutivePauses: number): number;
}
