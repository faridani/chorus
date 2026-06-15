import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexQuotaPolicy } from "@chorus/backends";
import type { ExitContext } from "@chorus/core";

const policy = new CodexQuotaPolicy({
  exhaustionPatterns: ["rate.?limit", "quota", "\\b429\\b"],
  backoffStartMs: 1000,
  backoffMaxMs: 60_000,
});

function ctx(partial: Partial<ExitContext>): ExitContext {
  return {
    exitCode: 0,
    signal: null,
    stderrTail: "",
    lastEvents: [],
    killedByUs: false,
    ...partial,
  };
}

test("classifyExit: clean exit → completed", () => {
  assert.equal(policy.classifyExit(ctx({ exitCode: 0 })), "completed");
});

test("classifyExit: killed-by-us wins", () => {
  assert.equal(policy.classifyExit(ctx({ killedByUs: true, exitCode: 1 })), "killed");
});

test("classifyExit: stderr rate-limit → quota_exhausted", () => {
  assert.equal(
    policy.classifyExit(ctx({ exitCode: 1, stderrTail: "Error: 429 rate limit reached" })),
    "quota_exhausted",
  );
});

test("classifyExit: quota_warning event → quota_exhausted", () => {
  assert.equal(
    policy.classifyExit(
      ctx({ exitCode: 1, lastEvents: [{ kind: "quota_warning", message: "x", at: 0 }] }),
    ),
    "quota_exhausted",
  );
});

test("classifyExit: signal → crashed", () => {
  assert.equal(policy.classifyExit(ctx({ exitCode: null, signal: "SIGSEGV" })), "crashed");
});

test("classifyExit: non-zero non-quota → failed", () => {
  assert.equal(policy.classifyExit(ctx({ exitCode: 2, stderrTail: "boom" })), "failed");
});

test("nextRetryAt: backoff grows and caps", () => {
  const now = 0;
  assert.equal(policy.nextRetryAt(now, 1), 1000);
  assert.equal(policy.nextRetryAt(now, 2), 2000);
  assert.equal(policy.nextRetryAt(now, 100), 60_000); // capped
});
