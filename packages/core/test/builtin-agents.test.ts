import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getBuiltInAgentTemplate,
  listAgentGalleryTemplates,
  loadBuiltInAgentTemplates,
  type BuiltInAgentDefinition,
} from "@chorus/core";

function validDefinition(overrides: Partial<BuiltInAgentDefinition> = {}): BuiltInAgentDefinition {
  return {
    id: "example-agent",
    name: "example-agent",
    displayName: "Example Agent",
    description: "A valid built-in agent for tests.",
    allowed: ["read context"],
    forbidden: ["write code"],
    backendId: "codex",
    allowedToolIds: ["repo.read"],
    forbiddenToolIds: ["repo.modify"],
    version: "1.0.0",
    category: "Test",
    ...overrides,
  };
}

function writeDefinition(dir: string, file: string, def: Partial<BuiltInAgentDefinition>): void {
  writeFileSync(join(dir, file), JSON.stringify(def, null, 2), "utf8");
}

test("loads source-owned built-in agents with gallery metadata", () => {
  const agents = loadBuiltInAgentTemplates();
  assert.equal(agents.length, 7);
  assert.equal(new Set(agents.map((a) => a.id)).size, agents.length);
  assert.equal(new Set(agents.map((a) => a.name)).size, agents.length);
  assert.ok(agents.every((a) => a.source === "builtin" && a.readOnly));

  const engineer = getBuiltInAgentTemplate({ id: "software-engineer" })!;
  assert.equal(engineer.name, "software-engineer");
  assert.equal(engineer.displayName, "Software Engineer");
  assert.ok(engineer.allowedToolIds.includes("repo.modify"));
  assert.ok(engineer.allowedToolIds.includes("verify.run"));
});

test("gallery composition keeps custom templates distinct from built-ins", () => {
  const gallery = listAgentGalleryTemplates([
    {
      id: "tmpl_custom",
      name: "software-engineer",
      description: "User-customized engineer",
      allowed: ["custom allowed"],
      forbidden: [],
      allowedToolIds: ["repo.read"],
      forbiddenToolIds: [],
      backendId: "codex",
      createdAt: 123,
    },
  ]);

  const matching = gallery.filter((t) => t.name === "software-engineer");
  assert.equal(matching.length, 2);
  assert.deepEqual(
    matching.map((t) => t.source).sort(),
    ["builtin", "custom"],
  );
  assert.equal(matching.find((t) => t.source === "custom")?.readOnly, false);
});

test("built-in loader rejects unknown tool ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "chorus-agents-"));
  writeDefinition(dir, "bad.json", validDefinition({ allowedToolIds: ["repo.read", "not.a.tool"] }));

  assert.throws(
    () => loadBuiltInAgentTemplates({ agentsDir: dir }),
    /Built-in agent validation failed:[\s\S]*Unknown tool id: not\.a\.tool/,
  );
});

test("built-in loader rejects duplicate ids and names", () => {
  const dir = mkdtempSync(join(tmpdir(), "chorus-agents-"));
  writeDefinition(dir, "one.json", validDefinition());
  writeDefinition(
    dir,
    "two.json",
    validDefinition({
      displayName: "Example Agent Two",
    }),
  );

  assert.throws(
    () => loadBuiltInAgentTemplates({ agentsDir: dir }),
    /Built-in agent validation failed:[\s\S]*duplicate built-in agent id "example-agent"[\s\S]*duplicate built-in agent name "example-agent"/,
  );
});
