import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  assert.ok(plan.assignments.some((a) => a.title.startsWith("Combined review:")));

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
      commit: "abc123",
      scopeViolations: [],
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

test("review planning includes root source files and does not traverse symlinked package roots", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "chorus-review-roots-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(join(repo, "main.py"), "print('hello')\n");
  mkdirSync(join(repo, "vendor", "external"), { recursive: true });
  symlinkSync(join(repo, "vendor"), join(repo, "packages"));
  const plan = buildCodeReviewPlan({
    project: { localPath: repo }, ticket: { title: "Review the codebase", body: "" }, maxAssignments: 4,
  });
  assert.deepEqual(plan?.assignments.flatMap((a) => a.scope), ["main.py"]);
});


test("broad review detection respects incidental mentions, negation, and narrow boundaries", () => {
  for (const [title, body] of [
    ["Improve billing retries", "Only modify packages/billing in this repository"],
    ["Do not review the entire codebase; fix billing only", ""],
    ["Improve billing retries", "This repository contains the billing service."],
    ["Review the codebase", "Changes limited to packages/billing."],
    ["Review billing", "Do not review the entire repository."],
    ["Improve billing in the repository", ""],
    ["Fix billing", "This is not a repository-wide review."],
    ["Fix billing", "No repository-wide cleanup is needed."],
  ]) assert.equal(isBroadCodeReviewTicket({ title: title!, body: body! }), false, title);
});

test("review planning covers container files and hidden configuration without noise", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "chorus-review-config-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const files = ["apps/shared.ts", "packages/README.md", "services/config.ts", "libs/index.ts",
    ".github/workflows/ci.yml", ".editorconfig", "packages/api/index.ts"];
  const noise = ["node_modules/lib/index.js", ".git/config", ".env", "private.key",
    "packages/dist/index.js", "services/credentials.json"];
  for (const file of [...files, ...noise]) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), "test");
  }
  const plan = buildCodeReviewPlan({
    project: { localPath: repo }, ticket: { title: "Review and improve the codebase", body: "" }, maxAssignments: 20,
  })!;
  const scopes = plan.assignments.flatMap((a) => a.scope);
  const owners = (file: string) => scopes.filter((scope) => file === scope || file.startsWith(scope + "/"));
  for (const file of files) assert.equal(owners(file).length, 1, file);
  for (const file of noise) assert.equal(owners(file).length, 0, file);
});

test("explicit scope declarations override broad titles before any repository-wide assignments", (t) => {
  const repo = mkdtempSync(join(tmpdir(), "chorus-review-boundaries-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  for (const area of ["packages/billing", "packages/auth", "apps/dashboard"]) {
    mkdirSync(join(repo, area), { recursive: true });
  }
  const title = "Review and improve the codebase";
  // Verify this fixture would otherwise generate unrelated assignments.
  assert.equal(buildCodeReviewPlan({ project: { localPath: repo }, ticket: { title, body: "" }, maxAssignments: 4 })?.assignments.length, 3);
  const declarations = [
    "Scope: packages/billing only.",
    "Scope: packages/billing", // No 'only' keyword is required.
    "Review scope is the billing retry service.",
    "In-scope: packages/billing",
    "Out of scope: packages/auth",
    "Affected area: billing",
    "Target files = packages/billing/index.ts",
    "Allowed paths: packages/billing/**",
    "Files: packages/billing/index.ts",
    "Boundaries — billing service",
    "Scope - packages/billing",
    "Restrict to packages/billing.",
    "Please restrict this review to the billing module.",
    "The review is restricted to packages/billing.",
    "Limit all changes to packages/billing.",
    "Confine the work within the billing service.",
    "Work is confined to packages/billing.",
  ];
  // Cross product guards against formatting-dependent scope expansion.
  for (const declaration of declarations) {
    for (const body of [declaration, `- **${declaration}**`, `> ${declaration}`, declaration.replaceAll(" ", "\t\n ")]) {
      const ticket = { title, body };
      assert.equal(isBroadCodeReviewTicket(ticket), false, body);
      assert.equal(buildCodeReviewPlan({ project: { localPath: repo }, ticket, maxAssignments: 4 }), null, body);
    }
  }
  for (const body of [
    "## Scope\n\n- `packages/billing`",
    "### Review Scope\r\n\r\nBilling only.",
    "**In scope**\n- packages/billing",
    "  **Scope**  :\t`packages/billing` only.",
    "Review the repository. Scope: packages/billing.",
  ]) assert.equal(isBroadCodeReviewTicket({ title, body }), false, body);
  assert.equal(isBroadCodeReviewTicket({ title: "Review the codebase — Scope: billing", body: "" }), false);
});

test("unqualified affirmative broad reviews still receive automatic plans", () => {
  for (const [title, body] of [
    ["Review and improve the codebase", "Focus on quality and docs."],
    ["Review the entire repository", "Check security, readability, and documentation."],
    ["Refine the code", "Repository-wide cleanup and hardening."],
    ["Code quality", "Please review our source tree."],
    ["**Review** and improve the **codebase**", "Document public modules and unsafe patterns."],
  ]) assert.equal(isBroadCodeReviewTicket({ title: title!, body: body! }), true, title);
});
