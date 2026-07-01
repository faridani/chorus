import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { Project, SuggestionDetails, Ticket } from "@chorus/core";

export interface CodeReviewAssignment {
  id: string;
  title: string;
  scope: string[];
  avoid: string[];
  goals: string[];
  documentationGoals: string[];
  securityGoals: string[];
  coordination: string;
  suggestedAgent: string | null;
  instruction: string;
}

export interface CodeReviewPlan {
  kind: "parallel_code_review";
  summary: string;
  assignments: CodeReviewAssignment[];
}

export interface ReviewAssignmentResult {
  assignmentId: string | null;
  title: string | null;
  agent: string;
  worktreeId: string;
  status: string | null;
  summary: string | null;
  filesChanged: string[];
  notes: string | null;
  suggestionsCreated: number;
}

interface CandidateArea {
  title: string;
  scope: string[];
  sortKey: string;
}

const REVIEW_TERMS = /\b(review|improve|refine|harden|clean\s*up|cleanup|quality|readability|maintainability|documentation|document|refactor)\b/i;
const BROAD_TERMS = /\b(codebase|repository|repo|project|whole\s+code|all\s+code|entire\s+code|source\s+tree|system)\b/i;
const CODE_REVIEW_TERMS = /\b(code\s*review|repo(?:sitory)?-wide|repository-wide|review\s+and\s+improve)\b/i;

const IGNORED_NAMES = new Set([
  ".git",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
]);

const ROOT_FILE_NAMES = [
  "README.md",
  "SECURITY.md",
  "SPEC.md",
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Dockerfile",
  "Containerfile",
];

const DEFAULT_GOALS = [
  "Improve readability and maintainability where the changes are safe and local.",
  "Reduce unnecessary complexity without changing public behavior.",
  "Make concrete code improvements when safe opportunities are found; avoid commentary-only results.",
  "Record meaningful findings, changes made, verification status, and unresolved concerns.",
];

const DEFAULT_DOCUMENTATION_GOALS = [
  "Add or improve comments, docstrings, README notes, or developer-facing documentation when they clarify non-obvious behavior.",
  "Prefer concise documentation close to the code or module being reviewed.",
];

const DEFAULT_SECURITY_GOALS = [
  "Look for exposed credentials, unsafe shell/database/file handling, injection risks, permission mistakes, and dependency hazards in scope.",
  "Fix obvious low-risk issues directly; create a structured suggestion for larger or risky security work.",
];

export function isBroadCodeReviewTicket(ticket: Pick<Ticket, "title" | "body">): boolean {
  const text = `${ticket.title}\n${ticket.body}`.toLowerCase();
  if (CODE_REVIEW_TERMS.test(text)) return true;
  if (BROAD_TERMS.test(text) && REVIEW_TERMS.test(text)) return true;
  return /\brefine\s+the\s+code\b/i.test(text) || /\breview\s+the\s+codebase\b/i.test(text);
}

export function buildCodeReviewPlan(args: {
  project: Pick<Project, "localPath">;
  ticket: Pick<Ticket, "title" | "body">;
  maxAssignments: number;
  agents?: { name: string; description: string }[];
}): CodeReviewPlan | null {
  if (!isBroadCodeReviewTicket(args.ticket)) return null;

  const maxAssignments = Math.max(1, args.maxAssignments);
  const areas = discoverReviewAreas(args.project.localPath);
  if (areas.length === 0) return null;

  const selected = consolidateAreas(areas, maxAssignments);
  const assignments = selected.map((area, index, all) => {
    const id = `review-${index + 1}`;
    const avoid = all
      .filter((other) => other !== area)
      .flatMap((other) => other.scope)
      .slice(0, 24);
    const suggestedAgent = chooseReviewAgent(args.agents ?? [], area);
    const assignment: Omit<CodeReviewAssignment, "instruction"> = {
      id,
      title: area.title,
      scope: area.scope,
      avoid,
      goals: DEFAULT_GOALS,
      documentationGoals: DEFAULT_DOCUMENTATION_GOALS,
      securityGoals: DEFAULT_SECURITY_GOALS,
      coordination:
        "This assignment is intended to be non-overlapping. Do not edit outside the listed scope unless the orchestrator explicitly coordinates a shared change.",
      suggestedAgent,
    };
    return { ...assignment, instruction: formatReviewAssignmentInstruction(assignment) };
  });

  return {
    kind: "parallel_code_review",
    summary:
      "Repository-wide review ticket detected. Delegate these scoped assignments independently, prefer one run_agent call per assignment, and reconcile the verified results before opening a PR.",
    assignments,
  };
}

export function formatReviewAssignmentInstruction(
  assignment: Omit<CodeReviewAssignment, "instruction">,
  extraInstruction?: string,
): string {
  const lines: string[] = [];
  lines.push(`Parallel code review assignment ${assignment.id}: ${assignment.title}`);
  lines.push("");
  lines.push("Scope - modify only these paths unless explicitly coordinated:");
  for (const path of assignment.scope) lines.push(`- ${path}`);
  lines.push("");
  lines.push("Avoid modifying these other review scopes:");
  for (const path of assignment.avoid.length ? assignment.avoid : ["(none)"]) lines.push(`- ${path}`);
  lines.push("");
  lines.push("Quality goals:");
  for (const goal of assignment.goals) lines.push(`- ${goal}`);
  lines.push("");
  lines.push("Documentation goals:");
  for (const goal of assignment.documentationGoals) lines.push(`- ${goal}`);
  lines.push("");
  lines.push("Security goals:");
  for (const goal of assignment.securityGoals) lines.push(`- ${goal}`);
  lines.push("");
  lines.push(`Coordination: ${assignment.coordination}`);
  lines.push(
    "When future work should not be done in this pass, include it in the final JSON `suggestions` array with title, rationale, affectedArea, proposedAction, and optional recommendedAgent/recommendedTool/recommendedSkill.",
  );
  lines.push("Report findings, concrete changes, verification, and unresolved risks in `summary` or `notes`.");
  if (extraInstruction?.trim()) {
    lines.push("");
    lines.push("Additional orchestrator instruction:");
    lines.push(extraInstruction.trim());
  }
  return lines.join("\n");
}

export function formatStructuredSuggestion(input: SuggestionDetails): string {
  const lines = [
    input.title,
    `Affected area: ${input.affectedArea}`,
    `Rationale: ${input.rationale}`,
    `Proposed action: ${input.proposedAction}`,
  ];
  const support = [input.recommendedAgent, input.recommendedTool, input.recommendedSkill].filter(Boolean);
  if (support.length) lines.push(`Recommended support: ${support.join(" · ")}`);
  return lines.join("\n");
}

export function buildReviewOutcomeSummary(plan: CodeReviewPlan | null, results: ReviewAssignmentResult[]): string {
  if (!plan || results.length === 0) return "";
  const completedIds = new Set(results.map((r) => r.assignmentId).filter(Boolean));
  const unreviewed = plan.assignments.filter((a) => !completedIds.has(a.id));
  const lines: string[] = [];
  lines.push("## Parallel Review Summary");
  lines.push(`Planned assignments: ${plan.assignments.length}`);
  lines.push(`Completed assignments: ${results.length}`);
  if (unreviewed.length) lines.push(`Not completed in this session: ${unreviewed.map((a) => a.id).join(", ")}`);
  lines.push("");
  lines.push("### Subagent Results");
  for (const result of results) {
    const title = result.title ?? result.assignmentId ?? "Unscoped review";
    lines.push(`- ${title} (${result.agent}, ${result.worktreeId}): ${result.status ?? "unknown"}`);
    if (result.summary) lines.push(`  Summary: ${result.summary}`);
    if (result.filesChanged.length) lines.push(`  Files: ${result.filesChanged.join(", ")}`);
    if (result.suggestionsCreated) lines.push(`  Suggestions created: ${result.suggestionsCreated}`);
    if (result.notes) lines.push(`  Notes: ${result.notes}`);
  }
  return lines.join("\n");
}

function discoverReviewAreas(repoRoot: string): CandidateArea[] {
  if (!existsSync(repoRoot)) return [];
  const areas: CandidateArea[] = [];
  const claimed = new Set<string>();

  for (const rootName of ["apps", "packages", "services", "libs"]) {
    const rootPath = join(repoRoot, rootName);
    if (!isDirectory(rootPath)) continue;
    for (const child of safeReadDir(rootPath)) {
      if (!child.isDirectory() || shouldIgnoreName(child.name)) continue;
      addArea(areas, claimed, {
        title: `${rootName}/${child.name}`,
        scope: [`${rootName}/${child.name}`],
        sortKey: `10:${rootName}/${child.name}`,
      });
    }
  }

  for (const entry of safeReadDir(repoRoot)) {
    if (!entry.isDirectory() || shouldIgnoreName(entry.name)) continue;
    if (["apps", "packages", "services", "libs"].includes(entry.name)) continue;
    const title = titleForTopLevelDir(entry.name);
    addArea(areas, claimed, { title, scope: [entry.name], sortKey: `20:${entry.name}` });
  }

  const rootFiles = ROOT_FILE_NAMES.filter((name) => existsSync(join(repoRoot, name)));
  if (rootFiles.length) {
    addArea(areas, claimed, {
      title: "Root configuration and operator docs",
      scope: rootFiles,
      sortKey: "30:root",
    });
  }

  return areas.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

function consolidateAreas(areas: CandidateArea[], maxAssignments: number): CandidateArea[] {
  if (areas.length <= maxAssignments) return areas;
  if (maxAssignments === 1) {
    return [{ title: "Repository-wide review", scope: areas.flatMap((a) => a.scope), sortKey: "99:all" }];
  }
  const selected = areas.slice(0, maxAssignments - 1);
  const remaining = areas.slice(maxAssignments - 1);
  selected.push({
    title: "Remaining support areas",
    scope: remaining.flatMap((a) => a.scope),
    sortKey: "99:remaining",
  });
  return selected;
}

function addArea(areas: CandidateArea[], claimed: Set<string>, area: CandidateArea): void {
  const scope = area.scope.filter((path) => !isCovered(path, claimed));
  if (scope.length === 0) return;
  for (const path of scope) claimed.add(path);
  areas.push({ ...area, scope });
}

function isCovered(path: string, claimed: Set<string>): boolean {
  for (const existing of claimed) {
    if (path === existing || path.startsWith(`${existing}/`) || existing.startsWith(`${path}/`)) return true;
  }
  return false;
}

function chooseReviewAgent(agents: { name: string; description: string }[], area: CandidateArea): string | null {
  if (agents.length === 0) return null;
  const text = `${area.title} ${area.scope.join(" ")}`.toLowerCase();
  const byName = (pattern: RegExp) => agents.find((a) => pattern.test(`${a.name} ${a.description}`.toLowerCase()))?.name;
  if (/security|auth|permission/.test(text)) return byName(/security/) ?? byName(/engineer|dev/) ?? agents[0]?.name ?? null;
  if (/test|qa|spec/.test(text)) return byName(/qa|test/) ?? byName(/engineer|dev/) ?? agents[0]?.name ?? null;
  if (/docs?|readme|architecture/.test(text)) return byName(/architect|refactor|engineer|dev/) ?? agents[0]?.name ?? null;
  return byName(/refactor|engineer|dev/) ?? agents[0]?.name ?? null;
}

function titleForTopLevelDir(name: string): string {
  const known: Record<string, string> = {
    agents: "Agent definitions",
    deploy: "Deployment assets",
    docs: "Documentation",
    scripts: "Developer scripts",
    src: "Legacy source package",
    tests: "Test suite",
  };
  return known[name] ?? basename(name);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function safeReadDir(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function shouldIgnoreName(name: string): boolean {
  return IGNORED_NAMES.has(name) || name.startsWith(".");
}
