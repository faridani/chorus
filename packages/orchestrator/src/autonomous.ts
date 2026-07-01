import type { Project, Role, Ticket, TicketEvent } from "@chorus/core";
import type { CodeReviewPlan, ReviewAssignmentResult } from "./code-review-plan.js";

/** A worktree created during an autonomous session, keyed by a short id. */
export interface SessionWorktree {
  id: string;
  path: string;
  branch: string;
}

/** Live state for one autonomous orchestrator session (one ticket). */
export interface SessionState {
  token: string;
  projectId: string;
  ticketId: string;
  ticketTitle: string;
  worktrees: Map<string, SessionWorktree>;
  /** Spoke-agent runs started so far (capped by maxSpokeAgentsPerSession). */
  spokeCount: number;
  /** Spoke-agent runs currently in flight (capped by maxParallelSpokeAgents). */
  running: number;
  createdAt: number;
  /** Set when the orchestrator takes a terminal action / calls finish. */
  finished: { outcome: string; message: string } | null;
  prUrl: string | null;
  /** Live spoke-agent handles, so a Stop tears them down with the session. */
  handles: Set<{ stop: (r: "killed") => Promise<void> }>;
  /** Deterministic plan for broad repository review tickets, when applicable. */
  reviewPlan: CodeReviewPlan | null;
  /** Review assignment ids currently or previously delegated in this session. */
  reviewAssignments: Map<string, { agent: string; worktreeId: string | null; status: "running" | "finished" }>;
  /** Structured outputs from scoped review subagents, used in the final PR summary. */
  reviewResults: ReviewAssignmentResult[];
}

export interface SpokeAgentInfo {
  name: string;
  description: string;
  backendId: string;
}

/**
 * Codex `-c` overrides that register the Chorus MCP bridge as a stdio server.
 * We use `-c` (not a temp CODEX_HOME) so the user's existing Codex auth in
 * ~/.codex is preserved. Launch via `node` against the compiled bridge for fast
 * startup (npx/tsx cold-start can miss codex's MCP startup window).
 *
 * `tool_timeout_sec` is the critical knob: a `run_agent`/`run_verify` tool call
 * is a full spoke run (minutes), but codex's default per-tool-call timeout is
 * ~120s — without raising it, every delegation "times out" from the
 * orchestrator's view while the spoke keeps running server-side. We set it to
 * comfortably exceed a spoke's max wall-clock (plus setup headroom).
 */
export function buildCodexMcpArgs(
  bridgeBin: string,
  daemonUrl: string,
  token: string,
  toolTimeoutSec: number,
): string[] {
  // The value is parsed as TOML; on Windows a backslash path would be read as
  // escape sequences. Forward slashes work on every platform node accepts.
  const normalizedBin = bridgeBin.replace(/\\/g, "/");
  // The bridge's own daemon-call cap MUST exceed the spoke wall-clock, or it
  // fires before the daemon-side worker finishes — exactly the premature
  // `fetch failed` that spawned duplicate workers. Tie it to the same budget as
  // codex's tool timeout so it can never be the first to give up.
  const callTimeoutMs = Math.ceil(toolTimeoutSec) * 1000;
  return [
    "-c",
    `mcp_servers.chorus.command="node"`,
    "-c",
    `mcp_servers.chorus.args=["${normalizedBin}"]`,
    "-c",
    `mcp_servers.chorus.env={ CHORUS_SESSION_TOKEN = "${token}", CHORUS_DAEMON_URL = "${daemonUrl}", CHORUS_DAEMON_CALL_TIMEOUT_MS = "${callTimeoutMs}" }`,
    "-c",
    `mcp_servers.chorus.startup_timeout_sec=30`,
    "-c",
    `mcp_servers.chorus.tool_timeout_sec=${Math.ceil(toolTimeoutSec)}`,
  ];
}

/**
 * System+task prompt for the autonomous orchestrator. Wording is deliberately
 * neutral — moderation-flavored language can fail the codex turn. It tells the
 * model to drive THIS ticket to a terminal outcome using the MCP tools.
 */
export function buildAutonomousPrompt(args: {
  project: Project;
  ticket: Ticket;
  agents: SpokeAgentInfo[];
  maxSpokeAgents: number;
  maxParallel: number;
}): string {
  const { project, ticket, agents, maxSpokeAgents, maxParallel } = args;
  const L: string[] = [];
  L.push("# You are the Chorus ORCHESTRATOR");
  L.push(
    "You coordinate a team of specialist coding agents to deliver ONE ticket. You do not edit code yourself — you delegate to spoke agents through the provided tools and decide, turn by turn, what to do next.",
  );
  L.push("");
  L.push("## Project");
  L.push(`- Repository: ${project.repoUrl}`);
  L.push(`- Base branch: ${project.baseBranch}`);
  if (project.expectations?.trim()) L.push(`- Expectations: ${project.expectations.trim()}`);
  if (project.groundRules?.length) L.push(`- Ground rules: ${project.groundRules.join("; ")}`);
  L.push("");
  L.push("## Ticket");
  L.push(`${ticket.title} (priority ${ticket.priority})`);
  L.push(ticket.body || "(no description)");
  L.push("");
  L.push("## Spoke agents you can delegate to");
  for (const a of agents) L.push(`- ${a.name} — ${a.description}`);
  if (agents.length === 0) L.push("- (none configured; you may close or escalate)");
  L.push("");
  L.push("## Your tools");
  L.push("- get_context: read the ticket, project settings, activity trail, and last attempt journal. Call this first.");
  L.push("- list_agents: list the spoke agents (names to use with run_agent).");
  L.push(
    "- run_agent(agent, instruction, baseWorktreeId?, reviewAssignmentId?): delegate work. Each call runs in its OWN git worktree and returns a worktreeId plus the agent's result, new commit count, and a diff summary. Omit baseWorktreeId to start fresh; pass a prior worktreeId to continue building in it. For codeReviewPlan assignments, pass the assignment id exactly as reviewAssignmentId.",
  );
  L.push("- run_verify(worktreeId): run the project's build/test/lint commands in a worktree.");
  L.push("- get_diff(worktreeId): inspect the committed changes in a worktree.");
  L.push("- merge_worktree(fromWorktreeId, intoWorktreeId): combine two branches (for parallel approaches).");
  L.push("- open_pr(worktreeId, summary): open the pull request from a worktree's branch. Terminal success.");
  L.push("- close_ticket(reason) / needs_human(reason): terminal actions when there's nothing to ship or a human is needed.");
  L.push("- create_ticket / add_suggestion / emit_activity: side actions for follow-ups, recommendations, and progress notes.");
  L.push("- finish(outcome, message): call LAST, after a terminal action, to end the session.");
  L.push("");
  L.push("## How to work");
  L.push("1. get_context to understand the task.");
  L.push(
    "2. Delegate implementation to the most fitting spoke agent(s) with a clear instruction. If get_context includes codeReviewPlan, use it as the planning step: dispatch one scoped assignment per subagent where budget allows, keep scopes non-overlapping, and pass reviewAssignmentId on each run_agent call.",
  );
  L.push(
    `3. You MAY run up to ${maxParallel} agents in parallel (e.g. two approaches, or implementation + tests) by issuing multiple run_agent calls; compare their diffs and merge_worktree the best work together.`,
  );
  L.push("4. Verify with run_verify and inspect with get_diff. If something is wrong, send a spoke agent back with a precise fix instruction (reuse its worktreeId).");
  L.push("5. YOU own the quality bar: open_pr only when the work genuinely satisfies the ticket and verification passes. Otherwise close_ticket or needs_human.");
  L.push(
    "6. For broad code review tickets, collect the subagent summaries, changed files, unresolved risks, and Suggestions entries into the open_pr summary so the final outcome is easy for a human to review.",
  );
  L.push("7. Call finish once you have taken a terminal action.");
  L.push("");
  L.push("## Guardrails");
  L.push("- Spoke agents commit on their own branch; they never push. Only open_pr ships work.");
  L.push(`- You have a budget of ${maxSpokeAgents} spoke-agent runs for this ticket — be decisive, avoid redundant runs.`);
  L.push("- Narrate your reasoning briefly in prose; rely on tool results (not guesses) for facts about the code.");
  return L.join("\n");
}

/** Prompt for a single spoke-agent run inside a session. */
export function buildSpokeAgentPrompt(args: {
  project: Project;
  ticket: Ticket;
  role: Role;
  instruction: string;
  resume: boolean;
  trail: TicketEvent[];
}): string {
  const { project, ticket, role, instruction, resume, trail } = args;
  const L: string[] = [];
  L.push(`# You are the ${role.name}`);
  if (role.description) L.push(role.description);
  L.push("");
  L.push("## Project");
  L.push(`- Repository: ${project.repoUrl}`);
  L.push(`- Base branch: ${project.baseBranch}`);
  if (project.expectations?.trim()) L.push(`- Expectations: ${project.expectations.trim()}`);
  if (project.groundRules?.length) L.push(`- Ground rules: ${project.groundRules.join("; ")}`);
  L.push("");
  if (role.allowed?.length) {
    L.push("## You are allowed to");
    for (const a of role.allowed) L.push(`- ${a}`);
    L.push("");
  }
  if (role.forbidden?.length) {
    L.push("## You must NOT");
    for (const f of role.forbidden) L.push(`- ${f}`);
    L.push("");
  }
  const coding = isCodingRole(role);
  L.push("## Global rules");
  L.push("- Work ONLY inside the current working directory (your worktree).");
  if (coding) {
    L.push("- Commit ALL your changes on the current branch. NEVER run `git push` or open a PR — the orchestrator does that.");
    L.push("- Make the smallest change that satisfies the instruction; run the project's checks before finishing.");
  } else {
    L.push(
      "- This is a read-only, advisory task. Investigate and reason, but do NOT edit files, commit, or run build/test/install commands (e.g. `npm test`). Deliver your full answer in the result below — there is nothing to commit.",
    );
  }
  L.push("");
  L.push("## Ticket");
  L.push(`${ticket.title}`);
  L.push(ticket.body || "(no description)");
  L.push("");
  L.push("## What the orchestrator wants from you now");
  L.push(instruction);
  L.push("");
  if (resume) {
    L.push("## Resuming");
    L.push("Prior work is already committed on this branch. Inspect the git state and build on it.");
    L.push("");
  }
  const recent = trail.slice(-6);
  if (recent.length) {
    L.push("## Recent activity on this ticket");
    for (const e of recent) L.push(`- [${e.actor} · ${e.kind}] ${e.message}`);
    L.push("");
  }
  L.push("## When you finish");
  if (coding) {
    L.push(
      'Return a single JSON object: { "status": "success" | "no_changes" | "blocked", "summary": string, "filesChanged": string[], "notes": string, "suggestions"?: [{ "title": string, "rationale": string, "affectedArea": string, "proposedAction": string, "recommendedAgent"?: string, "recommendedTool"?: string, "recommendedSkill"?: string }] }. status=success means work is done and committed; no_changes means nothing was needed; blocked means you could not proceed (explain in notes). Use suggestions only for deferred work that should appear in the Suggestions tab.',
    );
  } else {
    L.push(
      'Return a single JSON object: { "status": "success" | "blocked", "summary": string, "filesChanged": string[], "notes": string, "suggestions"?: [{ "title": string, "rationale": string, "affectedArea": string, "proposedAction": string, "recommendedAgent"?: string, "recommendedTool"?: string, "recommendedSkill"?: string }] }. Put your idea / findings / recommendation in `summary` (with any detail in `notes`) and leave `filesChanged` empty — advisory work commits nothing. status=success means you produced the requested analysis; blocked means you could not (explain in notes). Use suggestions only for deferred work that should appear in the Suggestions tab.',
    );
  }
  L.push("Narrate progress in prose; emit the JSON object exactly once, as your final message.");
  return L.join("\n");
}

/**
 * Whether a role may change the repo. Coding roles get commit/verify guidance;
 * advisory roles (planning, review, ideation, security analysis) are read-only
 * and deliver findings in their result instead of committing.
 *
 * The inference is deliberately conservative about the read-only verdict: a
 * role is only treated as advisory when there is an EXPLICIT signal for it.
 * Legacy roles predating the tool-permission migration carry empty tool lists
 * (the migration defaults both columns to `[]`) — classifying those as advisory
 * would silently stop upgraded `software-dev` agents from committing, so an
 * unconfigured role stays coding.
 */
export function isCodingRole(role: Role): boolean {
  const allowed = role.allowedToolIds ?? [];
  const forbidden = role.forbiddenToolIds ?? [];
  // Explicitly granted write capability → coding.
  if (allowed.includes("repo.modify") || allowed.includes("repo.commit")) return true;
  // Explicitly denied write capability → advisory/read-only (the built-in
  // advisory agents forbid repo.modify/repo.commit).
  if (forbidden.includes("repo.modify") || forbidden.includes("repo.commit")) return false;
  // No tool permissions configured at all (legacy/unmigrated role): we can't
  // infer intent, so preserve the original behavior and treat it as coding.
  if (allowed.length === 0 && forbidden.length === 0) return true;
  // An explicit, non-empty selection that omits the write tools is an
  // intentionally advisory role (e.g. product-designer: read + suggest only).
  return false;
}
