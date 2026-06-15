import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, Role, Ticket } from "@chorus/core";
import { buildAgentPrompt } from "@chorus/orchestrator";

const project: Project = {
  id: "p1",
  repoUrl: "owner/repo",
  localPath: "/tmp/x",
  integrationBranch: "chorus/integration",
  baseBranch: "main",
  specPath: "docs/SPEC.md",
  expectations: "Ship a delightful CLI that never loses data.",
  groundRules: ["Always add tests", "Keep PRs small"],
  runState: "running",
  status: "ready",
  createdAt: 0,
};

const ticket: Ticket = {
  id: "t1",
  projectId: "p1",
  title: "Add config loader",
  body: "Load config from a file.",
  status: "open",
  roleName: "software-dev",
  priority: 0,
  source: "spec",
  createdAt: 0,
  updatedAt: 0,
};

const role: Role = {
  id: "r1",
  projectId: "p1",
  name: "software-dev",
  description: "Implements tickets.",
  allowed: ["write code"],
  forbidden: ["delete data"],
  backendId: "codex",
};

test("prompt includes expectations, ground rules, and always-on safety rules", () => {
  const p = buildAgentPrompt({ project, role, ticket, specExcerpt: "the spec", resume: false });
  assert.match(p, /High-level expectations/);
  assert.match(p, /delightful CLI that never loses data/);
  assert.match(p, /Always add tests/);
  assert.match(p, /Keep PRs small/);
  // Always-on safety guardrails remain.
  assert.match(p, /NEVER run `git push`/);
  assert.match(p, /never touch the `main` branch/i);
  // Role guardrails present.
  assert.match(p, /delete data/);
  assert.match(p, /Add config loader/);
});

test("prompt omits expectations section when empty", () => {
  const p = buildAgentPrompt({
    project: { ...project, expectations: "", groundRules: [] },
    role,
    ticket,
    specExcerpt: null,
    resume: false,
  });
  assert.doesNotMatch(p, /High-level expectations/);
  // Safety rules still present.
  assert.match(p, /NEVER run `git push`/);
});
