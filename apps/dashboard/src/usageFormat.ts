import type { UsageTotals } from "./api.js";

export function formatTokenUsage(totals: UsageTotals | undefined): string {
  if (!totals) return "tokens: ?";
  const input = totals.inputTokens ?? 0;
  const output = totals.outputTokens ?? 0;
  const total = totals.totalTokens ?? input + output;
  const split = input || output || total === 0 ? `${input}/${output}` : "unavailable";
  return `tokens total: ${total} (in/out: ${split})`;
}
