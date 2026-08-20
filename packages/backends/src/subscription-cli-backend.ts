import { mkdirSync, writeFileSync } from "node:fs";
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
import { AsyncQueue } from "./async-queue.js";
import { extractUsage } from "./codex/events.js";
import { AGENT_RESULT_INSTRUCTIONS, AGENT_RESULT_SCHEMA } from "./result-schema.js";

export interface SubscriptionCliBackendOptions {
  quotaPolicy: QuotaPolicy;
  /** Default model (empty means CLI default). */
  defaultModel?: string;
  /** Override the binary (tests/custom installs). */
  bin?: string;
}

export class ClaudeBackend implements AIBackend {
  readonly id = "claude";
  readonly capabilities: BackendCapabilities = {
    structuredOutput: true,
    usageEvents: true,
    resume: false,
  };

  constructor(private readonly opts: SubscriptionCliBackendOptions) {}

  startRun(spec: AgentRunSpec): AgentRunHandle {
    const model = spec.model ?? this.opts.defaultModel;
    return startCliRun({
      id: this.id,
      bin: this.opts.bin ?? "claude",
      quotaPolicy: this.opts.quotaPolicy,
      capabilities: this.capabilities,
      spec,
      args: [
        "-p",
        spec.prompt,
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(AGENT_RESULT_SCHEMA),
        "--permission-mode",
        "bypassPermissions",
        ...(model ? ["--model", model] : []),
      ],
    });
  }
}

export class GeminiBackend implements AIBackend {
  readonly id = "gemini";
  readonly capabilities: BackendCapabilities = {
    structuredOutput: false,
    usageEvents: true,
    resume: false,
  };

  constructor(private readonly opts: SubscriptionCliBackendOptions) {}

  startRun(spec: AgentRunSpec): AgentRunHandle {
    const model = spec.model ?? this.opts.defaultModel;
    const prompt = `${spec.prompt}\n\n## Chorus final result\n${AGENT_RESULT_INSTRUCTIONS}`;
    return startCliRun({
      id: this.id,
      bin: this.opts.bin ?? "gemini",
      quotaPolicy: this.opts.quotaPolicy,
      capabilities: this.capabilities,
      spec,
      args: [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--approval-mode",
        "yolo",
        "--skip-trust",
        ...(model ? ["-m", model] : []),
      ],
    });
  }
}

function startCliRun(args: {
  id: string;
  bin: string;
  quotaPolicy: QuotaPolicy;
  capabilities: BackendCapabilities;
  spec: AgentRunSpec;
  args: string[];
}): AgentRunHandle {
  const { bin, quotaPolicy, spec } = args;
  mkdirSync(spec.artifactsDir, { recursive: true });
  const schemaPath = join(spec.artifactsDir, "schema.json");
  const outputPath = join(spec.artifactsDir, "result.json");
  const rawLogPath = join(spec.artifactsDir, "raw.log");
  writeFileSync(schemaPath, JSON.stringify(AGENT_RESULT_SCHEMA, null, 2), "utf8");

  const queue = new AsyncQueue<AgentEvent>();
  const stdoutLines: string[] = [];
  const parsedStdout: unknown[] = [];
  const lastEvents: AgentEvent[] = [];
  let usage: UsageCounters = {};
  let killedByUs = false;

  const proc = new StreamingProcess(bin, args.args, {
    cwd: spec.worktreePath,
    rawLogPath,
    maxWallClockMs: spec.maxWallClockMs,
    // Claude/Gemini JSON mode can stay quiet until the run completes. Keep the
    // hard wall-clock cap, but avoid treating a quiet healthy run as idle.
    idleTimeoutMs: undefined,
  });

  proc.onLine((line) => {
    stdoutLines.push(line);
    const parsed = parseJson(line);
    if (parsed.ok) parsedStdout.push(parsed.value);
    for (const ev of mapCliLine(line)) {
      if (ev.kind === "usage") usage = mergeUsage(usage, ev.usage);
      lastEvents.push(ev);
      if (lastEvents.length > 20) lastEvents.shift();
      queue.push(ev);
    }
  });

  const result: Promise<AgentResult> = (async () => {
    try {
      const exit = await proc.exit;
      const stdoutText = stdoutLines.join("\n");
      const payload = readPayload(stdoutText, parsedStdout);
      if (payload) writeFileSync(outputPath, JSON.stringify(payload, null, 2), "utf8");
      const finalUsage = readUsage(stdoutText, parsedStdout);
      if (finalUsage) usage = mergeUsage(usage, finalUsage);

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
          : quotaPolicy.classifyExit(ctx);
      if (killedByUs) terminalReason = "killed";

      return {
        payload,
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

function mapCliLine(raw: string): AgentEvent[] {
  const at = Date.now();
  if (!raw.trim()) return [];
  const parsed = parseJson(raw);
  if (!parsed.ok) {
    const payload = findPayload(raw);
    return payload ? [{ kind: "message", text: payload.summary, at }] : [{ kind: "log", line: raw, at }];
  }

  const events: AgentEvent[] = [];
  const usage = extractUsage(parsed.value);
  if (usage) events.push({ kind: "usage", usage, at });
  const err = errorText(parsed.value);
  if (err) {
    events.push(
      /(rate.?limit|quota|usage.?limit|\b429\b)/i.test(err)
        ? { kind: "quota_warning", message: err, at }
        : { kind: "log", line: err, at },
    );
  }
  const payload = findPayload(parsed.value);
  if (payload) events.push({ kind: "message", text: payload.summary, at });
  return events;
}

function readPayload(stdoutText: string, parsedStdout: unknown[]) {
  for (const obj of [...parsedStdout].reverse()) {
    const payload = findPayload(obj);
    if (payload) return payload;
  }
  return findPayload(stdoutText);
}

function readUsage(stdoutText: string, parsedStdout: unknown[]): UsageCounters | null {
  for (const obj of [...parsedStdout].reverse()) {
    const usage = extractUsage(obj);
    if (usage) return usage;
  }
  const parsed = parseJson(stdoutText);
  return parsed.ok ? extractUsage(parsed.value) : null;
}

function findPayload(value: unknown, depth = 0): ReturnType<typeof AgentResultPayloadSchema.parse> | null {
  if (depth > 8) return null;
  const direct = AgentResultPayloadSchema.safeParse(value);
  if (direct.success) return direct.data;

  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return null;
    const parsed = parseJson(text);
    if (parsed.ok) return findPayload(parsed.value, depth + 1);
    for (const candidate of jsonCandidates(text)) {
      const candidateParsed = parseJson(candidate);
      if (!candidateParsed.ok) continue;
      const payload = findPayload(candidateParsed.value, depth + 1);
      if (payload) return payload;
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of [...value].reverse()) {
      const payload = findPayload(item, depth + 1);
      if (payload) return payload;
    }
    return null;
  }

  if (typeof value !== "object" || value === null) return null;
  const rec = value as Record<string, unknown>;
  for (const key of [
    "structured_output",
    "structuredOutput",
    "result",
    "response",
    "output",
    "content",
    "message",
    "text",
    "data",
  ]) {
    if (key in rec) {
      const payload = findPayload(rec[key], depth + 1);
      if (payload) return payload;
    }
  }
  for (const nested of Object.values(rec)) {
    const payload = findPayload(nested, depth + 1);
    if (payload) return payload;
  }
  return null;
}

function jsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]) candidates.push(match[1].trim());
  }

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      if (depth === 0) {
        candidates.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return candidates;
}

function errorText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const rec = value as Record<string, unknown>;
  if (typeof rec.error === "string") return rec.error;
  if (typeof rec.message === "string" && /error|failed|quota|rate.?limit|\b429\b/i.test(rec.message)) {
    return rec.message;
  }
  if (typeof rec.error === "object" && rec.error !== null) {
    const err = rec.error as Record<string, unknown>;
    if (typeof err.message === "string") return err.message;
    if (typeof err.type === "string") return err.type;
  }
  return "";
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
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

function pickMax(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}
