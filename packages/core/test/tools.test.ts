import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentTemplate,
  getTool,
  templateToRoleInput,
  TOOL_CATALOG,
  validateToolSelection,
} from "@chorus/core";

test("catalog ids are unique and fields are populated", () => {
  const ids = TOOL_CATALOG.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate tool id");
  for (const t of TOOL_CATALOG) {
    assert.ok(t.id && t.name && t.description && t.usageNote, `incomplete tool ${t.id}`);
    assert.ok(["available", "planned"].includes(t.availability));
    assert.ok(["low", "medium", "high"].includes(t.risk));
  }
  // The sandbox-real tools are marked available.
  assert.equal(getTool("repo.modify")?.availability, "available");
  assert.equal(getTool("tickets.create")?.availability, "planned");
});

test("validateToolSelection rejects unknown ids", () => {
  const r = validateToolSelection(["repo.read", "nope.bad"], []);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nope\.bad/);
});

test("validateToolSelection rejects allowed∩forbidden overlap", () => {
  const r = validateToolSelection(["repo.read"], ["repo.read"]);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /both allowed and forbidden/);
});

test("validateToolSelection accepts a valid disjoint selection", () => {
  assert.deepEqual(validateToolSelection(["repo.read", "verify.run"], ["prs.open.request"]), {
    ok: true,
  });
  assert.deepEqual(validateToolSelection([], []), { ok: true });
});

test("templateToRoleInput copies tool permissions", () => {
  const tmpl: AgentTemplate = {
    id: "t1",
    name: "qa",
    description: "tester",
    allowed: ["run tests"],
    forbidden: ["delete data"],
    allowedToolIds: ["repo.read", "verify.run"],
    forbiddenToolIds: ["prs.open.request"],
    backendId: "codex",
    createdAt: 0,
  };
  const input = templateToRoleInput(tmpl);
  assert.deepEqual(input.allowedToolIds, ["repo.read", "verify.run"]);
  assert.deepEqual(input.forbiddenToolIds, ["prs.open.request"]);
  assert.deepEqual(input.allowed, ["run tests"]);
  assert.equal(input.name, "qa");
});
