import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, ConfigSchema, type Project, type Ticket } from "@chorus/core";
import { GitService } from "@chorus/git-service";
import { Orchestrator } from "../src/orchestrator.js";
import type { SessionState } from "../src/autonomous.js";
import { buildCodeReviewPlan, buildReviewAssignmentResult, buildReviewOutcomeSummary, reviewScopeViolations } from "../src/code-review-plan.js";

// Exercise the actual PR gate with real branch histories. The PR transport is
// replaced so tests never push or contact GitHub.
test("review handoff requires every latest assignment commit in the selected branch", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "chorus-review-handoff-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  for (const name of ["api", "web"]) {
    mkdirSync(join(repo, "packages", name), { recursive: true });
    writeFileSync(join(repo, "packages", name, "index.ts"), "export {};\n");
  }
  git("add", ".");
  git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  const project = { id: "p", localPath: repo, baseBranch: "main" } as Project;
  const ticket = { id: "t", title: "Review and improve the codebase", body: "" } as Ticket;
  const plan = buildCodeReviewPlan({ project, ticket, maxAssignments: 4 })!;
  const results = [];
  const worktrees = new Map();
  for (const [index, assignment] of plan.assignments.entries()) {
    const branch = `review-${index}`;
    git("checkout", "-b", branch, "main");
    const file = `${assignment.scope[0]}/README.md`;
    writeFileSync(join(repo, file), "Module documentation\n");
    git("add", ".");
    git("commit", "-m", "Document module");
    worktrees.set(branch, { id: branch, path: repo, branch });
    results.push(buildReviewAssignmentResult({
      assignment, agent: "dev", worktreeId: branch, status: "success",
      summary: `Reviewed ${assignment.title}`, authoritativeFilesChanged: [file],
      notes: null, suggestionsCreated: 1, commit: git("rev-parse", "HEAD"),
    }));
  }
  const session = { reviewPlan: plan, reviewResults: results, reviewAssignments: new Map(), worktrees, running: 0 } as unknown as SessionState;
  let opened = 0;
  let body = "";
  const orchestrator = new Orchestrator({
    db: { updateTicket() {} } as never, git: new GitService(), backends: {} as never,
    notifier: { id: "test", notify: async () => {} }, bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: repo }),
  });
  const internal = orchestrator as unknown as {
    sessionOpenPr(session: SessionState, project: Project, ticket: Ticket, body: object): Promise<{ status: number; body: unknown }>;
    openPrForTicket(project: Project, ticket: Ticket, args: { reviewer: { summary: string } }): Promise<string>;
  };
  internal.openPrForTicket = async (_project, _ticket, args) => {
    opened++;
    body = args.reviewer.summary;
    return "https://example.com/pr/1";
  };
  const open = () => internal.sessionOpenPr(session, project, ticket, { worktreeId: "review-0", summary: "Review" });
  assert.equal((await open()).status, 409, "unmerged assignment must block PR creation");
  assert.equal(opened, 0);
  git("checkout", "review-0");
  git("merge", "--no-ff", "--no-edit", "review-1");
  assert.equal((await open()).status, 200);
  assert.match(body, /Completed assignments: 2/);
  for (const result of results) assert.ok(body.includes(result.commit!));

  session.running = 1;
  assert.equal((await open()).status, 409, "do not race an active agent");
  session.running = 0;
  results.push({ ...results[1]!, status: "blocked", notes: "Needs follow-up" });
  assert.equal((await open()).status, 409, "latest blocked attempt supersedes earlier success");
  assert.match(buildReviewOutcomeSummary(plan, results), /Completed assignments: 1/);
  results.pop();
  results.push({ ...results[1]!, scopeViolations: ["packages/api/index.ts"] });
  assert.equal((await open()).status, 409, "out-of-scope review cannot ship");
  results.pop();

  git("checkout", "review-1");
  writeFileSync(join(repo, "packages/web/README.md"), "New review\n");
  git("commit", "-am", "Follow-up");
  results.push({ ...results[1]!, commit: git("rev-parse", "HEAD") });
  assert.equal((await open()).status, 409, "a later attempt must also be merged");
  assert.equal(opened, 1);
});

test("scope checks use exact Git paths and include both sides of renames", async (t) => {
  const repo = mkdtempSync(join(tmpdir(), "chorus-review-scope-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  mkdirSync(join(repo, "api"));
  mkdirSync(join(repo, "api-other"));
  writeFileSync(join(repo, "api", "with\nnewline.ts"), "source\n");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("mv", "api/with\nnewline.ts", "api-other/moved.ts");
  git("commit", "-m", "move");
  const service = new GitService();
  const paths = await service.reviewChangedFiles(repo, base, "HEAD");
  assert.deepEqual(new Set(paths), new Set(["api/with\nnewline.ts", "api-other/moved.ts"]));
  assert.deepEqual(reviewScopeViolations(["api"], paths), ["api-other/moved.ts"]);
  await assert.rejects(service.reviewChangedFiles(repo, "missing-ref", "HEAD"));
  await assert.rejects(service.isAncestor(repo, "missing-ref", "HEAD"));
});

test("agent follow-up suggestions retain structured fields and are capped per result", () => {
  const saved: Record<string, unknown>[] = [];
  const orchestrator = new Orchestrator({
    db: { insertSuggestion(suggestion: Record<string, unknown>) { saved.push(suggestion); } } as never,
    git: {} as never, backends: {} as never,
    notifier: { id: "test", notify: async () => {} }, bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: "." }),
  });
  const suggestion = {
    title: "Separate permissions", rationale: "Requires architectural review",
    affectedArea: "packages/api", proposedAction: "Design a permission boundary",
    recommendedAgent: "security-analyst", recommendedTool: "scanner", recommendedSkill: "security-review",
  };
  const internal = orchestrator as unknown as {
    persistAgentSuggestions(project: Project, ticketId: string, suggestions: typeof suggestion[]): number;
  };
  assert.equal(internal.persistAgentSuggestions({ id: "p" } as Project, "t", Array(25).fill(suggestion)), 20);
  assert.equal(saved.length, 20);
  for (const [key, value] of Object.entries(suggestion)) assert.equal(saved[0]?.[key], value);
  assert.equal(saved[0]?.ticketId, "t");
  assert.equal(internal.persistAgentSuggestions({ id: "p" } as Project, "t", [{ ...suggestion, rationale: " " }]), 0);
});

test("a failed review retry invalidates the earlier successful result", async () => {
  const assignment = {
    id: "review-1", title: "api", scope: ["api"], avoid: [], goals: [],
    documentationGoals: [], securityGoals: [], coordination: "", suggestedAgent: "dev", instruction: "",
  };
  const session = {
    spokeCount: 0, running: 0, handles: new Set(),
    worktrees: new Map([["wt", { id: "wt", path: ".", branch: "review" }]]),
    reviewPlan: { kind: "parallel_code_review", summary: "Review", assignments: [assignment] },
    reviewAssignments: new Map([[assignment.id, { agent: "dev", worktreeId: "wt", status: "finished" }]]),
    reviewResults: [buildReviewAssignmentResult({
      assignment, agent: "dev", worktreeId: "wt", status: "success", summary: "Prior attempt",
      authoritativeFilesChanged: ["api/index.ts"], notes: null, suggestionsCreated: 0, commit: "prior-commit",
    })],
  } as unknown as SessionState;
  const orchestrator = new Orchestrator({
    db: {
      getRole: () => ({ name: "dev", backendId: "test", allowedToolIds: [], forbiddenToolIds: [] }),
      insertTask() {}, insertRun() {},
    } as never,
    git: { headCommit: async () => "base", branchSummary: async () => ({ commits: [], files: [] }) } as never,
    backends: { has: () => true, get: () => ({ prepare: async () => { throw new Error("backend unavailable"); } }) } as never,
    notifier: { id: "test", notify: async () => {} }, bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: "." }),
  });
  const internal = orchestrator as unknown as {
    runAgentInSession(session: SessionState, project: Project, ticket: Ticket, body: object): Promise<unknown>;
  };
  await assert.rejects(internal.runAgentInSession(session, { id: "p", localPath: ".", baseBranch: "main" } as Project,
    { id: "t" } as Ticket, { agent: "dev", instruction: "Retry", baseWorktreeId: "wt", reviewAssignmentId: assignment.id }),
    /backend unavailable/);
  assert.equal(session.running, 0);
  assert.equal(session.reviewResults.at(-1)?.status, "blocked");
  assert.equal(session.reviewResults.at(-1)?.commit, null);
  assert.match(buildReviewOutcomeSummary(session.reviewPlan, session.reviewResults), /Completed assignments: 0/);
});

test("parallel assignments cannot claim another worktree while setup is running", async () => {
  const assignment = {
    id: "review-1", title: "api", scope: ["api"], avoid: [], goals: [],
    documentationGoals: [], securityGoals: [], coordination: "", suggestedAgent: "dev", instruction: "",
  };
  const session = {
    spokeCount: 0, running: 0, handles: new Set(), worktrees: new Map(), reviewAssignments: new Map(), reviewResults: [],
    reviewPlan: { kind: "parallel_code_review", summary: "Review", assignments: [assignment, { ...assignment, id: "review-2", scope: ["web"] }] },
  } as unknown as SessionState;
  const orchestrator = new Orchestrator({
    db: { getRole: () => ({ name: "dev", backendId: "test", allowedToolIds: [], forbiddenToolIds: [] }) } as never,
    git: { addWorktree: async () => {} } as never, backends: {} as never,
    notifier: { id: "test", notify: async () => {} }, bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: "." }),
  });
  const internal = orchestrator as unknown as {
    runAgentInSession(session: SessionState, project: Project, ticket: Ticket, body: object): Promise<{ status: number }>;
    runSetup(): Promise<void>;
  };
  const project = { id: "p", localPath: ".", baseBranch: "main" } as Project;
  const ticket = { id: "t" } as Ticket;
  internal.runSetup = async () => {
    const wt = [...session.worktrees.values()][0]!;
    assert.equal(session.reviewAssignments.get("review-1")?.worktreeId, wt.id);
    const response = await internal.runAgentInSession(session, project, ticket, {
      agent: "dev", instruction: "Review", reviewAssignmentId: "review-2", baseWorktreeId: wt.id,
    });
    assert.equal(response.status, 409);
    throw new Error("setup unavailable");
  };
  await assert.rejects(internal.runAgentInSession(session, project, ticket, {
    agent: "dev", instruction: "Review", reviewAssignmentId: "review-1",
  }), /setup unavailable/);
});
