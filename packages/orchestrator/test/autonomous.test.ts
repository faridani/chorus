import assert from "node:assert/strict";
import { test } from "node:test";
import type { Project, Role, Ticket } from "@chorus/core";
import { buildAutonomousPrompt, buildCodexMcpArgs, buildSpokeAgentPrompt, isCodingRole } from "../src/autonomous.js";

const project = {
  id: "p1",
  repoUrl: "git@github.com:acme/widgets.git",
  baseBranch: "main",
  expectations: "Ship small, safe changes.",
  groundRules: ["No force pushes", "Keep tests green"],
  setupCommand: "npm install",
  verifyCommands: ["npm test"],
} as unknown as Project;

const ticket = {
  id: "t1",
  title: "Add a /health endpoint",
  body: "Return 200 OK at /health.",
  priority: 3,
} as unknown as Ticket;

const role = {
  name: "software-engineer",
  description: "Implements features.",
  allowed: ["edit code"],
  forbidden: ["push to remote"],
  allowedToolIds: ["repo.read", "repo.modify", "repo.commit", "verify.run"],
  backendId: "codex",
} as unknown as Role;

const advisoryRole = {
  name: "product-designer",
  description: "Proposes feature ideas.",
  allowed: ["read the repo"],
  forbidden: ["edit code"],
  allowedToolIds: ["repo.read", "tickets.suggest"],
  forbiddenToolIds: [],
  backendId: "codex",
} as unknown as Role;

// A role created before the tool-permission migration: both lists empty.
const legacyRole = {
  name: "software-dev",
  description: "Implements features.",
  allowed: ["edit code"],
  forbidden: [],
  allowedToolIds: [],
  forbiddenToolIds: [],
  backendId: "codex",
} as unknown as Role;

test("buildCodexMcpArgs registers a node-launched stdio server with session env and a long tool timeout", () => {
  const args = buildCodexMcpArgs("/abs/agent-mcp/dist/bin.js", "http://127.0.0.1:7878", "tok-123", 4500);
  const joined = args.join(" ");
  assert.ok(joined.includes(`mcp_servers.chorus.command="node"`));
  assert.ok(joined.includes(`mcp_servers.chorus.args=["/abs/agent-mcp/dist/bin.js"]`));
  assert.ok(joined.includes(`CHORUS_SESSION_TOKEN = "tok-123"`));
  assert.ok(joined.includes(`CHORUS_DAEMON_URL = "http://127.0.0.1:7878"`));
  // The bridge's own daemon-call cap is derived from the tool timeout (ms) so it
  // always outlasts the spoke wall-clock and can't fire first.
  assert.ok(joined.includes(`CHORUS_DAEMON_CALL_TIMEOUT_MS = "4500000"`));
  // Long per-tool-call timeout so a multi-minute run_agent isn't abandoned at ~120s.
  assert.ok(joined.includes(`mcp_servers.chorus.tool_timeout_sec=4500`));
  assert.ok(joined.includes(`mcp_servers.chorus.startup_timeout_sec=30`));
  // -c override pairs (command, args, env, startup_timeout, tool_timeout)
  assert.equal(args.filter((a) => a === "-c").length, 5);
});

test("buildAutonomousPrompt lists the agent, the tools, and the parallel budget", () => {
  const p = buildAutonomousPrompt({
    project,
    ticket,
    agents: [{ name: "software-engineer", description: "Implements features.", backendId: "codex" }],
    maxSpokeAgents: 12,
    maxParallel: 3,
  });
  assert.ok(p.includes("software-engineer"));
  for (const tool of [
    "get_context",
    "attempt_journal.read",
    "attempt_journal.write",
    "run_agent",
    "run_verify",
    "merge_worktree",
    "open_pr",
    "finish",
  ]) {
    assert.ok(p.includes(tool), `prompt mentions ${tool}`);
  }
  assert.ok(/before reassigning or restarting work/i.test(p));
  assert.ok(/Before open_pr, close_ticket, needs_human, or finish/i.test(p));
  assert.ok(p.includes("up to 3 agents in parallel"));
  assert.ok(p.includes("budget of 12"));
  // Neutral wording: nothing that trips codex's moderation filter.
  assert.ok(!/secret token/i.test(p));
});

test("buildSpokeAgentPrompt embeds the instruction, role rules, and result contract", () => {
  const p = buildSpokeAgentPrompt({
    project,
    ticket,
    role,
    instruction: "Add the /health route and a test.",
    resume: false,
    trail: [],
  });
  assert.ok(p.includes("software-engineer"));
  assert.ok(p.includes("Add the /health route and a test."));
  assert.ok(p.includes("NEVER run `git push`"));
  assert.ok(p.includes("run the project's checks before finishing"));
  assert.ok(p.includes('"status"') && p.includes("filesChanged"));
});

test("buildSpokeAgentPrompt gives advisory (non-coding) roles read-only, no-commit guidance", () => {
  const p = buildSpokeAgentPrompt({
    project,
    ticket,
    role: advisoryRole,
    instruction: "Propose one new feature idea.",
    resume: false,
    trail: [],
  });
  // No commit/verify guidance for a role that can't modify the repo.
  assert.ok(!p.includes("Commit ALL your changes"));
  assert.ok(!p.includes("run the project's checks before finishing"));
  // Read-only framing + advisory result contract instead.
  assert.ok(/read-only, advisory task/i.test(p));
  assert.ok(p.includes("leave `filesChanged` empty"));
});

test("buildSpokeAgentPrompt keeps coding guidance for legacy roles with empty tool lists", () => {
  const p = buildSpokeAgentPrompt({
    project,
    ticket,
    role: legacyRole,
    instruction: "Implement the feature.",
    resume: false,
    trail: [],
  });
  // An unconfigured (legacy) role must NOT be downgraded to advisory, or
  // upgraded installs would silently stop committing implementation work.
  assert.ok(p.includes("Commit ALL your changes"));
  assert.ok(p.includes("run the project's checks before finishing"));
  assert.ok(!/read-only, advisory task/i.test(p));
});

test("isCodingRole: advisory only on explicit signal; empty lists stay coding", () => {
  assert.equal(isCodingRole(role), true); // grants repo.modify/commit
  assert.equal(isCodingRole(legacyRole), true); // empty lists → coding
  assert.equal(isCodingRole(advisoryRole), false); // explicit non-empty, no write tools
  // Explicit denial of write capability → advisory.
  const forbidWrite = { ...role, allowedToolIds: [], forbiddenToolIds: ["repo.modify", "repo.commit"] } as Role;
  assert.equal(isCodingRole(forbidWrite), false);
});
