import type { AgentEvent, PlanItem, UsageCounters } from "@chorus/core";

/**
 * Translate one line of Codex's `--json` (JSONL) stream into normalized
 * AgentEvents. Codex emits `thread.started`, `turn.started/completed`, and
 * `item.started/updated/completed` envelopes whose `item.type` is one of
 * reasoning | agent_message | command_execution | file_change | todo_list.
 * Parsing is defensive: unknown shapes never throw (the raw log is the record).
 *
 * `worktreePath` (when given) is stripped from file-change paths so they show
 * as repo-relative.
 */
export function mapCodexLine(raw: string, worktreePath?: string): AgentEvent[] {
  const at = Date.now();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return raw.trim() ? [{ kind: "log", line: raw, at }] : [];
  }
  if (typeof obj !== "object" || obj === null) return [{ kind: "log", line: raw, at }];

  const rec = obj as Record<string, unknown>;
  const type = typeof rec.type === "string" ? rec.type : "";

  // Usage rides on turn.completed (and possibly other envelopes).
  if (type === "turn.completed" || type === "turn.failed") {
    const usage = extractUsage(rec);
    const events: AgentEvent[] = usage ? [{ kind: "usage", usage, at }] : [];
    if (type === "turn.failed") {
      const msg = errText(rec);
      if (/(rate.?limit|quota|usage.?limit|\b429\b)/i.test(msg)) {
        events.push({ kind: "quota_warning", message: msg, at });
      } else if (msg) {
        events.push({ kind: "log", line: msg, at });
      }
    }
    return events;
  }

  if (type === "error") {
    const msg = errText(rec);
    return /(rate.?limit|quota|usage.?limit|\b429\b)/i.test(msg)
      ? [{ kind: "quota_warning", message: msg, at }]
      : [{ kind: "log", line: msg || raw, at }];
  }

  // item.* envelopes carry the interesting work.
  if (type === "item.started" || type === "item.completed" || type === "item.updated") {
    const item = (rec.item as Record<string, unknown>) ?? {};
    const itemType = typeof item.type === "string" ? item.type : "";
    // Emit commands when started; everything else when completed (final form),
    // so we don't double-report.
    const isStart = type === "item.started";

    switch (itemType) {
      case "reasoning":
        return type === "item.completed" && str(item.text)
          ? [{ kind: "reasoning", text: str(item.text)!, at }]
          : [];
      case "agent_message": {
        if (type !== "item.completed") return [];
        const text = str(item.text);
        if (!text) return [];
        // The final message is the JSON result; surface its summary, not raw JSON.
        const summary = jsonSummary(text);
        return [{ kind: "message", text: summary ?? text, at }];
      }
      case "command_execution": {
        const command = str(item.command) ?? "";
        if (!command) return [];
        // Show each command once when it starts (liveness); on completion only
        // surface failures, so the feed isn't doubled for every command.
        if (isStart) return [{ kind: "command", command, status: "running", at }];
        if (type === "item.completed") {
          const exitCode = typeof item.exit_code === "number" ? item.exit_code : null;
          if (exitCode !== null && exitCode !== 0) {
            return [{ kind: "command", command, status: "failed", exitCode, at }];
          }
        }
        return [];
      }
      case "file_change": {
        if (type !== "item.completed") return [];
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const files = changes
          .map((c) => relPath(str((c as Record<string, unknown>)?.path) ?? "", worktreePath))
          .filter(Boolean);
        return files.length ? [{ kind: "file_change", files, at }] : [];
      }
      case "todo_list": {
        const raw = Array.isArray(item.items) ? item.items : [];
        const items: PlanItem[] = raw.map((p) => ({
          text: str((p as Record<string, unknown>)?.text) ?? "",
          completed: Boolean((p as Record<string, unknown>)?.completed),
        }));
        return items.length ? [{ kind: "plan", items, at }] : [];
      }
      default:
        return [];
    }
  }

  // thread.started / turn.started and anything else: no user-facing event.
  return [];
}

/** Recursively search for token counts under common key spellings. */
export function extractUsage(obj: unknown): UsageCounters | null {
  return findUsage(obj, 0);
}

function findUsage(obj: unknown, depth: number): UsageCounters | null {
  if (depth > 5 || typeof obj !== "object" || obj === null) return null;
  const rec = obj as Record<string, unknown>;
  const input = numField(rec, ["input_tokens", "prompt_tokens", "inputTokens", "prompt"]);
  const output = numField(rec, ["output_tokens", "completion_tokens", "outputTokens", "candidates"]);
  const total = numField(rec, ["total_tokens", "totalTokens", "tokens", "token_count", "total"]);
  if (input !== undefined || output !== undefined || total !== undefined) {
    return { inputTokens: input, outputTokens: output, totalTokens: total ?? sum(input, output), raw: rec };
  }
  for (const value of Object.values(rec)) {
    const nested = findUsage(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function errText(rec: Record<string, unknown>): string {
  if (typeof rec.message === "string") return rec.message;
  const err = rec.error as Record<string, unknown> | undefined;
  if (err && typeof err.message === "string") return err.message;
  return "";
}

/** If `text` is our JSON result payload, return its summary; else null. */
function jsonSummary(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith("{")) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    if (typeof o.summary === "string") return o.summary;
  } catch {
    /* not JSON */
  }
  return null;
}

function relPath(path: string, worktreePath?: string): string {
  if (!path) return "";
  if (worktreePath && path.startsWith(worktreePath)) {
    return path.slice(worktreePath.length).replace(/^\/+/, "");
  }
  return path;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
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
