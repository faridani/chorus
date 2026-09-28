import { existsSync, readdirSync, lstatSync } from "node:fs";
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
  /** Immutable branch tip at completion; never trust a model-reported SHA. */
  commit: string | null;
  scopeViolations: string[];
}

interface CandidateArea {
  title: string;
  scope: string[];
  sortKey: string;
}

// Require the broad scope to be the object of the review request, rather
// than matching unrelated words anywhere in a ticket.
const REVIEW_ACTION = String.raw`(?:review|improve|refine|harden|clean\s*up|refactor|document)(?:\s+and\s+(?:review|improve|refine|harden|document))*`;
const BROAD_OBJECT = String.raw`(?:(?:the|this|our|entire|whole|full)\s+)*(?:codebase|repository|repo|source\s+tree)\b`;
const BROAD_REQUEST = new RegExp(String.raw`\b${REVIEW_ACTION}\s+${BROAD_OBJECT}|\b(?:repo(?:sitory)?|codebase|project)[- ]wide\s+(?:review|cleanup|hardening|refactoring|quality|documentation|improvements?)\b`, "i");
const CONFIG_NAMES = new Set([".github", ".gitlab", ".devcontainer", ".vscode", ".gitignore", ".gitattributes", ".editorconfig", ".dockerignore"]);

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
  // Ignore Markdown presentation so emphasis, headings, lists, and line wrapping
  // cannot hide a boundary. This text is used only for intent classification.
  const text = `${ticket.title}\n${ticket.body}`.toLowerCase().replace(/[*_`#>|]/g, " ");
  // A declared scope takes precedence over broad defaults. Do not try to infer
  // paths from free text: even ambiguous declarations stay with normal ticket
  // handling instead of granting every repository area to the automatic planner.
  const scopeLabel = String.raw`(?:(?:in|out\s+of|review|task|work|change|allowed|target)\s*[- ]?\s*)?scope|(?:(?:affected|target|allowed|in[- ]scope)\s+)?(?:areas?|paths?|files?|directories|modules?|packages?)|boundaries`;
  if (new RegExp(String.raw`\b(?:${scopeLabel})\s*(?::|=|[-–—]|\bis\b|\bare\b)`).test(text)
    || new RegExp(String.raw`^\s*(?:[-+]|\d+[.)])?\s*(?:${scopeLabel})\s*$`, "m").test(text)
    || /\b(?:(?:restrict|limit)(?:ed|ing)?|confin(?:e|ed|ing))\b[^.!?;:]*?\b(?:to|within)\b/.test(text)) return false;
  // Explicit boundaries override even a broad title. Be conservative with
  // negated requests: a narrow ticket must never acquire repository-wide scope.
  if (/\b(?:do not|don't|never|not)\s+(?:review|improve|refine|harden|refactor)\b/.test(text)
    || /\b(?:only\s+(?:modify|edit|change|review|fix|touch)|(?:scope|changes?|work)\s+(?:is\s+)?(?:limited|restricted)\s+to)\b/.test(text)
    || /\b(?:fix|review|modify|edit)\s+[^.;\n]+\s+only\b/.test(text)) return false;
  const request = BROAD_REQUEST.exec(text);
  if (!request) return false;
  const prefix = text.slice(0, request.index);
  return !/\b(?:not|no|never|without|don't)\b[^.!?;\n]*$/.test(prefix);
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

export function buildReviewAssignmentResult(args: {
  assignment: Pick<CodeReviewAssignment, "id" | "title">;
  agent: string;
  worktreeId: string;
  status: string | null;
  summary: string | null;
  authoritativeFilesChanged: string[];
  notes: string | null;
  suggestionsCreated: number;
  commit?: string | null;
  scopeViolations?: string[];
}): ReviewAssignmentResult {
  return {
    assignmentId: args.assignment.id,
    title: args.assignment.title,
    agent: args.agent,
    worktreeId: args.worktreeId,
    status: args.status,
    summary: args.summary,
    filesChanged: [...args.authoritativeFilesChanged],
    notes: args.notes,
    suggestionsCreated: args.suggestionsCreated,
    commit: args.commit ?? null,
    scopeViolations: args.scopeViolations ?? [],
  };
}

export function buildReviewOutcomeSummary(plan: CodeReviewPlan | null, results: ReviewAssignmentResult[]): string {
  if (!plan || results.length === 0) return "";
  results = latestReviewResults(results);
  const completedIds = new Set(results.filter(isCompletedReviewResult).map((r) => r.assignmentId));
  const unreviewed = plan.assignments.filter((a) => !completedIds.has(a.id));
  const lines: string[] = [];
  lines.push("## Parallel Review Summary");
  lines.push(`Planned assignments: ${plan.assignments.length}`);
  lines.push(`Completed assignments: ${completedIds.size}`);
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
    if (result.commit) lines.push(`  Reviewed commit: ${result.commit}`);
    if (result.scopeViolations.length) lines.push(`  Out-of-scope changes: ${result.scopeViolations.join(", ")}`);
  }
  return lines.join("\n");
}

export function latestReviewResults(results: ReviewAssignmentResult[]): ReviewAssignmentResult[] {
  return [...new Map(results.map((result) => [result.assignmentId, result])).values()];
}

export function isCompletedReviewResult(result: ReviewAssignmentResult): boolean {
  return (result.status === "success" || result.status === "no_changes") && result.scopeViolations.length === 0;
}

/** Scope boundaries are path segments, not arbitrary string prefixes. */
export function reviewScopeViolations(scope: string[], files: string[]): string[] {
  return files.filter((file) => !scope.some((path) => file === path || file.startsWith(`${path}/`)));
}

function discoverReviewAreas(repoRoot: string): CandidateArea[] {
  if (!existsSync(repoRoot)) return [];
  const areas: CandidateArea[] = [];
  const claimed = new Set<string>();

  for (const rootName of ["apps", "packages", "services", "libs"]) {
    const rootPath = join(repoRoot, rootName);
    if (!isDirectory(rootPath)) continue;
    const directFiles = safeReadDir(rootPath)
      .filter((child) => child.isFile() && !shouldIgnoreName(child.name))
      .map((child) => `${rootName}/${child.name}`).sort();
    if (directFiles.length) addArea(areas, claimed, {
      title: `${rootName} shared source and configuration`,
      scope: directFiles, sortKey: `10:${rootName}/~shared`,
    });
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

  const rootFiles = safeReadDir(repoRoot)
    .filter((entry) => entry.isFile() && (ROOT_FILE_NAMES.includes(entry.name) || !shouldIgnoreName(entry.name)))
    .map((entry) => entry.name)
    .sort();
  if (rootFiles.length) {
    addArea(areas, claimed, {
      title: "Root source, configuration and operator docs",
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
    title: `Combined review: ${remaining.map((area) => area.title).join(", ")}`,
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
    return lstatSync(path).isDirectory();
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
  return IGNORED_NAMES.has(name)
    || /^(?:secrets?|credentials?)(?:[.-]|$)|\.(?:pem|key|p12|pfx|log|tsbuildinfo)$/i.test(name)
    || (name.startsWith(".") && !CONFIG_NAMES.has(name));
}
