import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { looksLikeJsonObject, parseStructuredOutput } from "../src/structured-run.js";

const Schema = z.object({ ok: z.boolean(), note: z.string().optional().default("") });

function tmpFile(contents: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "chorus-so-")), "out.json");
  writeFileSync(p, contents, "utf8");
  return p;
}

test("returns parsed data for valid output (success regardless of exit code)", () => {
  const r = parseStructuredOutput(tmpFile('{"ok":true,"note":"hi"}'), Schema);
  assert.ok(r.ok);
  if (r.ok) assert.deepEqual(r.data, { ok: true, note: "hi" });
});

test("missing output file → not ok, never throws", () => {
  const r = parseStructuredOutput(join(tmpdir(), "does-not-exist-xyz.json"), Schema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /no output file/);
});

test("invalid JSON → not ok", () => {
  const r = parseStructuredOutput(tmpFile("not json {"), Schema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not valid JSON/);
});

test("schema mismatch → not ok", () => {
  const r = parseStructuredOutput(tmpFile('{"ok":"nope"}'), Schema);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /schema validation/);
});

test("looksLikeJsonObject: suppresses schema-shaped interim emissions", () => {
  // The premature evaluator artifacts seen in the wild — must be dropped from the feed.
  assert.equal(looksLikeJsonObject('{"passed":false,"failures":["commentary channel constrained"]}'), true);
  assert.equal(looksLikeJsonObject('  {"approved": true}  '), true);
});

test("looksLikeJsonObject: keeps prose narration", () => {
  assert.equal(looksLikeJsonObject("I'm going to inspect the branch diff, read-only."), false);
  assert.equal(looksLikeJsonObject(""), false);
  // A summary that merely mentions JSON is still prose, not an object literal.
  assert.equal(looksLikeJsonObject("Returned {ok} after checking the diff"), false);
});

test("looksLikeJsonObject: arrays and scalars are not objects (kept)", () => {
  assert.equal(looksLikeJsonObject('["a","b"]'), false);
  assert.equal(looksLikeJsonObject("42"), false);
  assert.equal(looksLikeJsonObject('{ broken json'), false);
});
