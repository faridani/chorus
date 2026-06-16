/**
 * Chorus agent-MCP stdio bridge.
 *
 * The autonomous orchestrator runs as `codex exec` with this process registered
 * as a stdio MCP server (`-c mcp_servers.chorus.command="node" args=[<this>]`).
 * Each tool call is a thin HTTP request to the daemon's session-scoped internal
 * API (the daemon owns all logic + state). Launched with `node` for fast
 * startup so codex's MCP startup window never times out.
 *
 * Env (injected by the orchestrator when it spawns codex):
 *   CHORUS_DAEMON_URL    e.g. http://127.0.0.1:7878
 *   CHORUS_SESSION_TOKEN opaque token scoping calls to one {project, ticket}
 *
 * Tool/description wording is deliberately neutral — "secret"/"exploit"-style
 * language intermittently trips codex's content moderation and fails the turn.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodRawShape } from "zod";
import { z } from "zod";

const DAEMON_URL = process.env.CHORUS_DAEMON_URL ?? "http://127.0.0.1:7878";
const TOKEN = process.env.CHORUS_SESSION_TOKEN ?? "";

interface ToolSpec {
  name: string;
  description: string;
  input: ZodRawShape;
  method: "GET" | "POST";
  /** Path suffix under /api/internal/sessions/:token */
  path: string;
}

const TOOLS: ToolSpec[] = [
  {
    name: "get_context",
    description:
      "Read the current ticket, project settings, recent activity trail, and the last attempt journal. Call this first to understand the task.",
    input: {},
    method: "GET",
    path: "/context",
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

async function callDaemon(
  method: "GET" | "POST",
  path: string,
  body: unknown,
): Promise<{ ok: boolean; text: string }> {
  const url = `${DAEMON_URL}/api/internal/sessions/${encodeURIComponent(TOKEN)}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body ?? {}) : undefined,
    });
    const text = await res.text();
    return { ok: res.ok, text };
  } catch (err) {
    return { ok: false, text: `bridge could not reach daemon: ${String(err)}` };
  }
}

const server = new McpServer({ name: "chorus", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.input },
    async (args: Record<string, unknown>) => {
      const { ok, text } = await callDaemon(tool.method, tool.path, args);
      return { content: [{ type: "text", text }], isError: !ok };
    },
  );
}

await server.connect(new StdioServerTransport());
process.stderr.write(`[chorus-mcp] connected (daemon=${DAEMON_URL})\n`);
