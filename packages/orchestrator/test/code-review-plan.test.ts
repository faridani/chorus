import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  buildCodeReviewPlan,
  buildReviewAssignmentResult,
  buildReviewOutcomeSummary,
  formatStructuredSuggestion,
  isBroadCodeReviewTicket,
} from "../src/code-review-plan.js";

test("isBroadCodeReviewTicket detects repository-wide review and ignores narrow review wording", () => {
  assert.equal(
    isBroadCodeReviewTicket({ title: "Review and improve the codebase", body: "Focus on quality and docs." } as never),
    true,
  );
  assert.equal(
    isBroadCodeReviewTicket({ title: "Refine the code", body: "Repository-wide cleanup and hardening." } as never),
    true,
  );
  assert.equal(
    isBroadCodeReviewTicket({ title: "Improve the billing system", body: "Make billing retries easier to follow." } as never),
    false,
  );
  assert.equal(
    isBroadCodeReviewTicket({ title: "Refactor project creation flow", body: "Simplify the create-project wizard." } as never),
    false,
  );
  assert.equal(
    isBroadCodeReviewTicket({ title: "Address PR review feedback", body: "Fix the login route comment." } as never),
    false,
  );
});

test("buildCodeReviewPlan creates scoped non-overlapping assignments with quality docs security goals", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "chorus-review-plan-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const dir of [
    "packages/api/src",
    "packages/web/src",
    "apps/dashboard/src",
    "docs",
    "tests",
    "src/legacy",
  ]) {
    mkdirSync(join(repo, dir), { recursive: true });
  }
  writeFileSync(join(repo, "README.md"), "readme\n");
  writeFileSync(join(repo, "package.json"), "{}\n");

  const plan = buildCodeReviewPlan({
    project: { localPath: repo },
    ticket: { title: "Review and improve the codebase", body: "" },
    maxAssignments: 4,
    agents: [{ name: "software-dev", description: "Implements code quality improvements" }],
  } as never);

  assert.ok(plan);
  assert.equal(plan.assignments.length, 4);
  assert.equal(plan.assignments[0]?.scope[0], "apps/dashboard");
  assert.ok(plan.assignments.some((a) => a.title === "Remaining support areas"));

  const scopes = plan.assignments.flatMap((a) => a.scope);
  for (const left of scopes) {
    for (const right of scopes) {
      if (left === right) continue;
      assert.equal(left.startsWith(`${right}/`) || right.startsWith(`${left}/`), false, `${left} overlaps ${right}`);
    }
  }

  const brief = plan.assignments[0]?.instruction ?? "";
  assert.match(brief, /Scope - modify only these paths/);
  assert.match(brief, /readability and maintainability/);
  assert.match(brief, /Documentation goals/);
  assert.match(brief, /Security goals/);
  assert.match(brief, /suggestions.*title, rationale, affectedArea, proposedAction/i);
});

test("buildReviewOutcomeSummary makes subagent results human-reviewable", () => {
  const plan = {
    kind: "parallel_code_review" as const,
    summary: "review",
    assignments: [
      {
        id: "review-1",
        title: "packages/api",
        scope: ["packages/api"],
        avoid: ["apps/dashboard"],
        goals: [],
        documentationGoals: [],
        securityGoals: [],
        coordination: "",
        suggestedAgent: "software-dev",
        instruction: "",
      },
      {
        id: "review-2",
        title: "apps/dashboard",
        scope: ["apps/dashboard"],
        avoid: ["packages/api"],
        goals: [],
        documentationGoals: [],
        securityGoals: [],
        coordination: "",
        suggestedAgent: "software-dev",
        instruction: "",
      },
    ],
  };

  const summary = buildReviewOutcomeSummary(plan, [
    {
      assignmentId: "review-1",
      title: "packages/api",
      agent: "software-dev",
      worktreeId: "wt_1",
      status: "success",
      summary: "Simplified validation and added README notes.",
      filesChanged: ["packages/api/src/server.ts", "packages/api/README.md"],
      notes: "No unresolved risks.",
      suggestionsCreated: 1,
    },
  ]);

  assert.match(summary, /Parallel Review Summary/);
  assert.match(summary, /Planned assignments: 2/);
  assert.match(summary, /Not completed in this session: review-2/);
  assert.match(summary, /Simplified validation/);
  assert.match(summary, /Suggestions created: 1/);
});

test("review assignment summaries report authoritative diff files", () => {
  const plan = {
    kind: "parallel_code_review" as const,
    summary: "review",
    assignments: [
      {
        id: "review-1",
        title: "packages/api",
        scope: ["packages/api"],
        avoid: [],
        goals: [],
        documentationGoals: [],
        securityGoals: [],
        coordination: "",
        suggestedAgent: "software-dev",
        instruction: "",
      },
    ],
  };
  const modelReportedFiles = ["packages/api/src/server.ts"];
  const authoritativeFiles = ["packages/api/src/server.ts", "packages/api/README.md"];

  const result = buildReviewAssignmentResult({
    assignment: plan.assignments[0]!,
    agent: "software-dev",
    worktreeId: "wt_1",
    status: "success",
    summary: "Changed validation.",
    authoritativeFilesChanged: authoritativeFiles,
    notes: null,
    suggestionsCreated: 0,
  });

  assert.deepEqual(result.filesChanged, authoritativeFiles);
  assert.notDeepEqual(result.filesChanged, modelReportedFiles);
  const summary = buildReviewOutcomeSummary(plan, [result]);
  assert.match(summary, /packages\/api\/src\/server\.ts/);
  assert.match(summary, /packages\/api\/README\.md/);
});

test("formatStructuredSuggestion includes required review suggestion fields", () => {
  const text = formatStructuredSuggestion({
    title: "Split auth middleware",
    rationale: "The route layer and auth checks are tightly coupled.",
    affectedArea: "packages/web/src/server.ts",
    proposedAction: "Create a focused auth middleware ticket.",
    recommendedAgent: "software-architect",
    recommendedTool: "security.report",
  });
  assert.match(text, /Split auth middleware/);
  assert.match(text, /Affected area: packages\/web\/src\/server\.ts/);
  assert.match(text, /Rationale:/);
  assert.match(text, /Proposed action:/);
  assert.match(text, /software-architect/);
});
