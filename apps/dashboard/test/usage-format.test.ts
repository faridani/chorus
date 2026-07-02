import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokenUsage } from "../src/usageFormat.js";

test("formatTokenUsage shows total-only usage without a misleading 0/0 summary", () => {
  assert.equal(
    formatTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 5 }),
    "tokens total: 5 (in/out: unavailable)",
  );
});

test("formatTokenUsage keeps split token counts when available", () => {
  assert.equal(
    formatTokenUsage({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }),
    "tokens total: 13 (in/out: 10/3)",
  );
  assert.equal(formatTokenUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }), "tokens total: 0 (in/out: 0/0)");
});
