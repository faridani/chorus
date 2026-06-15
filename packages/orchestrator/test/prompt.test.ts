import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, Role, Ticket, TicketEvent } from "@chorus/core";
import { buildAgentPrompt, buildManifest } from "@chorus/orchestrator";

const project: Project = {
  id: "p1",
  repoUrl: "owner/repo",
  localPath: "/tmp/x",
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
  branch: null,
  worktreePath: null,
  prUrl: null,
  prNumber: null,
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

test("worker prompt carries the orchestrator's latest direction + prior work", () => {
  const trail: TicketEvent[] = [
    {
      id: "e1",
      projectId: "p1",
      ticketId: "t1",
      actor: "software-dev",
      kind: "work",
      message: "success: added the backend move_ticket helper",
      createdAt: 1,
    },
    {
      id: "e2",
      projectId: "p1",
      ticketId: "t1",
      actor: "orchestrator",
      kind: "triage",
      message: "Backend is done; now implement the frontend drag/drop UI that calls it.",
      createdAt: 2,
    },
  ];
  const p = buildAgentPrompt({ project, role, ticket, specExcerpt: null, resume: true, trail });
  assert.match(p, /What the orchestrator wants from you now/);
  assert.match(p, /implement the frontend drag\/drop UI/);
  assert.match(p, /Already done on this ticket/);
  assert.match(p, /backend move_ticket helper/);
  // Worker is told it may report blocked if the change is impossible here.
  assert.match(p, /status: blocked/);
});

test("prompt includes the task manifest: verify commands + prior failure evidence", () => {
  const manifest = buildManifest({
    project: { ...project, setupCommand: "npm install", verifyCommands: ["npm test"] },
    ticket,
    attempt: 2,
    branch: { commits: ["abc add loader"], files: ["src/config.ts"] },
    trail: [],
    latestJournal: {
      id: "j1",
      taskId: "task1",
      ticketId: "t1",
      projectId: "p1",
      attempt: 1,
      promptHash: null,
      diffHash: null,
      verifyPassed: false,
      verifyOutput: "npm test\nFAIL config loads from file",
      diagnosis: "Loader ignores the path argument",
      nextAction: "reassign-to-worker",
      evaluatorVerdict: null,
      reviewerVerdict: null,
      proof: null,
      createdAt: 1,
    },
    artifactsDir: `${process.env.TMPDIR ?? "/tmp"}/chorus-manifest-test-${Date.now()}`,
  });
  const p = buildAgentPrompt({ project, role, ticket, specExcerpt: null, resume: true, manifest });
  assert.match(p, /Task manifest/);
  assert.match(p, /npm test/);
  assert.match(p, /What failed on the previous attempt/);
  assert.match(p, /Loader ignores the path argument/);
  assert.match(p, /src\/config\.ts/);
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
