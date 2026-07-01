import assert from "node:assert/strict";
import { test } from "node:test";
import { TOOLS } from "../src/tools.js";

test("bridge registers scoped attempt-journal tools", () => {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  const read = byName.get("attempt_journal.read");
  const write = byName.get("attempt_journal.write");

  assert.ok(read, "attempt_journal.read is registered");
  assert.equal(read.method, "POST");
  assert.equal(read.path, "/attempt_journal.read");
  assert.deepEqual(Object.keys(read.input), ["limit"]);
  assert.match(read.description, /session token/i);

  assert.ok(write, "attempt_journal.write is registered");
  assert.equal(write.method, "POST");
  assert.equal(write.path, "/attempt_journal.write");
  for (const field of ["verification", "verifyPassed", "diagnosis", "proof", "nextAction"]) {
    assert.ok(field in write.input, `write input includes ${field}`);
  }
  assert.ok(!("projectId" in write.input));
  assert.ok(!("ticketId" in write.input));
});
