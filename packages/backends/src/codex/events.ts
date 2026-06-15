import type { AgentEvent, UsageCounters } from "@chorus/core";

/**
 * Codex's `--json` event schema is not a stable public contract and varies by
 * version, so we parse defensively: pull out a human-readable message and any
 * token usage we can find, and never throw on an unexpected shape. The raw log
 * (kept separately) is the forensic record.
 */
export function mapCodexLine(raw: string): AgentEvent[] {
  const at = Date.now();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Non-JSON noise (progress bars, warnings). Keep as a log line.
    return raw.trim() ? [{ kind: "log", line: raw, at }] : [];
  }
  if (typeof obj !== "object" || obj === null) {
    return [{ kind: "log", line: raw, at }];
  }

  const events: AgentEvent[] = [];
  const rec = obj as Record<string, unknown>;
  const type = pickString(rec, ["type", "msg_type"]) ?? nestedType(rec);

  const usage = extractUsage(rec);
  if (usage) events.push({ kind: "usage", usage, at });

  const message = pickString(rec, ["message", "text", "content", "delta"]);
  if (type && /tool|command|exec|patch|apply/i.test(type)) {
    events.push({ kind: "tool_use", tool: type, detail: message, at });
  } else if (message) {
    events.push({ kind: "progress", message, at });
  }

  if (type && /(rate.?limit|quota|usage.?limit)/i.test(type)) {
    events.push({ kind: "quota_warning", message: message ?? type, at });
  }

  if (events.length === 0) {
    events.push({ kind: "log", line: raw, at });
  }
  return events;
}

/** Recursively search for token counts under common key spellings. */
export function extractUsage(obj: unknown): UsageCounters | null {
  const found = findUsage(obj, 0);
  return found;
}

function findUsage(obj: unknown, depth: number): UsageCounters | null {
  if (depth > 5 || typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;

  const input = numField(rec, ["input_tokens", "prompt_tokens", "inputTokens"]);
  const output = numField(rec, ["output_tokens", "completion_tokens", "outputTokens"]);
  const total = numField(rec, ["total_tokens", "totalTokens", "tokens", "token_count"]);

  if (input !== undefined || output !== undefined || total !== undefined) {
    return {
      inputTokens: input,
      outputTokens: output,
      totalTokens: total ?? sum(input, output),
      raw: rec,
    };
  }

  for (const value of Object.values(rec)) {
    const nested = findUsage(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function nestedType(rec: Record<string, unknown>): string | undefined {
  const msg = rec.msg;
  if (msg && typeof msg === "object") {
    return pickString(msg as Record<string, unknown>, ["type"]);
  }
  return undefined;
}

function pickString(rec: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function numField(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
}

function sum(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
