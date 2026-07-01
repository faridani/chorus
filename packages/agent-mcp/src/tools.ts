import type { ZodRawShape } from "zod";
import { z } from "zod";

export interface ToolSpec {
  name: string;
  description: string;
  input: ZodRawShape;
  method: "GET" | "POST";
  /** Path suffix under /api/internal/sessions/:token */
  path: string;
}

export const TOOLS: ToolSpec[] = [
  {
    name: "get_context",
    description:
      "Read the current ticket, project settings, recent activity trail, and the last attempt journal. Call this first to understand the task.",
    input: {},
    method: "GET",
    path: "/context",
  },
  {
    name: "attempt_journal.read",
    description:
      "Read recent attempt-journal entries for the current session ticket. Scope is derived from the session token; caller-supplied project or ticket IDs are ignored.",
    input: {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Maximum number of recent entries to return for this session ticket"),
    },
    method: "POST",
    path: "/attempt_journal.read",
  },
  {
    name: "attempt_journal.write",
    description:
      "Write a scoped attempt-journal handoff for the current session ticket. Include verification status/output, diagnosis, proof, and nextAction before finishing or handing off.",
    input: {
      verification: z.string().optional().describe("What verification was run and the relevant result/output"),
      verifyPassed: z
        .boolean()
        .optional()
        .describe("Whether verification passed; omit when not run or unknown"),
      diagnosis: z.string().optional().describe("Failure diagnosis, blocker, or concise status"),
      proof: z.string().optional().describe("Commit, branch, PR, or evidence supporting the handoff"),
      nextAction: z.string().optional().describe("Recommended next action for the session or retry"),
    },
    method: "POST",
    path: "/attempt_journal.write",
  },
  {
    name: "list_agents",
    description:
      "List the spoke agents you can delegate to (name, description, backend). Use these names with run_agent.",
    input: {},
    method: "GET",
    path: "/agents",
  },
  {
    name: "run_agent",
    description:
      "Delegate work to a spoke agent. It runs in its own git worktree and commits to a branch, then returns its structured result, the new commits, and a diff summary. Omit baseWorktreeId to start fresh; pass an existing worktreeId to continue/build on that worktree.",
    input: {
      agent: z.string().describe("Spoke agent name from list_agents"),
      instruction: z.string().describe("What this agent should accomplish"),
      baseWorktreeId: z
        .string()
        .optional()
        .describe("Continue in this existing worktree instead of creating a new one"),
    },
    method: "POST",
    path: "/run-agent",
  },
  {
    name: "run_verify",
    description:
      "Run the project's configured verification commands (build/test/lint) in a worktree and return pass/fail and output.",
    input: { worktreeId: z.string() },
    method: "POST",
    path: "/verify",
  },
  {
    name: "get_diff",
    description: "Return the git diff of a worktree's branch against the project base branch.",
    input: { worktreeId: z.string() },
    method: "POST",
    path: "/diff",
  },
  {
    name: "merge_worktree",
    description:
      "Merge the commits from one worktree's branch into another worktree's branch. Use to combine parallel approaches before opening a PR. Reports any conflicts.",
    input: { fromWorktreeId: z.string(), intoWorktreeId: z.string() },
    method: "POST",
    path: "/merge",
  },
  {
    name: "open_pr",
    description:
      "Open a pull request from the given worktree's branch. This is the terminal success action for the ticket.",
    input: {
      worktreeId: z.string(),
      summary: z.string().describe("PR body summary of the change"),
      title: z.string().optional(),
    },
    method: "POST",
    path: "/open-pr",
  },
  {
    name: "close_ticket",
    description:
      "Close the ticket without a PR (nothing to do, duplicate, or obsolete). Terminal action.",
    input: { reason: z.string() },
    method: "POST",
    path: "/close",
  },
  {
    name: "needs_human",
    description: "Block the ticket and ask a human to step in. Terminal action.",
    input: { reason: z.string() },
    method: "POST",
    path: "/needs-human",
  },
  {
    name: "create_ticket",
    description: "Create a follow-up ticket for separate work discovered along the way.",
    input: { title: z.string(), body: z.string(), priority: z.number().optional() },
    method: "POST",
    path: "/create-ticket",
  },
  {
    name: "add_suggestion",
    description: "Surface a human-visible suggestion or recommendation for this project/ticket.",
    input: { text: z.string() },
    method: "POST",
    path: "/suggest",
  },
  {
    name: "emit_activity",
    description: "Post a short progress message to the live activity feed.",
    input: { message: z.string() },
    method: "POST",
    path: "/activity",
  },
  {
    name: "finish",
    description:
      "Signal that you are done with this ticket. Call after a terminal action (open_pr/close_ticket/needs_human) with a short summary of what happened.",
    input: {
      outcome: z.enum(["pr_opened", "closed", "blocked", "abandoned"]),
      message: z.string(),
    },
    method: "POST",
    path: "/finish",
  },
];
