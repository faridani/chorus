import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type AgentTemplate,
  getTool,
  resolveToolPermissions,
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

test("resolveToolPermissions marks absent catalog tools unspecified", () => {
  const catalog = [
    getTool("repo.read")!,
    getTool("repo.modify")!,
    getTool("prs.open.request")!,
  ];
  const resolved = resolveToolPermissions(["repo.read"], ["prs.open.request"], catalog);

  assert.deepEqual(
    resolved.map((p) => [p.tool.id, p.state]),
    [
      ["repo.read", "allowed"],
      ["repo.modify", "unspecified"],
      ["prs.open.request", "disallowed"],
    ],
  );
});

test("resolveToolPermissions treats missing legacy selections as unspecified", () => {
  const catalog = [getTool("repo.read")!, getTool("repo.commit")!];
  const resolved = resolveToolPermissions(null, undefined, catalog);

  assert.deepEqual(
    resolved.map((p) => [p.tool.id, p.state]),
    [
      ["repo.read", "unspecified"],
      ["repo.commit", "unspecified"],
    ],
  );
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
    backendId: "gemini",
    model: "gemini-2.5-pro",
    createdAt: 0,
  };
  const input = templateToRoleInput(tmpl);
  assert.deepEqual(input.allowedToolIds, ["repo.read", "verify.run"]);
  assert.deepEqual(input.forbiddenToolIds, ["prs.open.request"]);
  assert.deepEqual(input.allowed, ["run tests"]);
  assert.equal(input.name, "qa");
  assert.equal(input.backendId, "gemini");
  assert.equal(input.model, "gemini-2.5-pro");
});

test("templateToRoleInput defaults missing legacy tool fields to unspecified", () => {
  const input = templateToRoleInput({
    name: "legacy",
    description: "old template",
    allowed: [],
    forbidden: [],
    backendId: "codex",
  });

  assert.deepEqual(input.allowedToolIds, []);
  assert.deepEqual(input.forbiddenToolIds, []);
});
