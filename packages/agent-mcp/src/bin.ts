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
import { callDaemon, DEFAULT_CALL_TIMEOUT_MS } from "./client.js";
import { TOOLS } from "./tools.js";

const DAEMON_URL = process.env.CHORUS_DAEMON_URL ?? "http://127.0.0.1:7878";
const TOKEN = process.env.CHORUS_SESSION_TOKEN ?? "";
if (!TOKEN) {
  // Without a session token every tool call would 404; fail loudly so the
  // misconfiguration surfaces at startup instead of as obscure routing errors.
  process.stderr.write("[chorus-mcp] CHORUS_SESSION_TOKEN is required\n");
  process.exit(1);
}

// Allow the orchestrator to tune the per-call cap (it injects a value derived
// from the spoke wall-clock budget). Standalone default is a generous 30 min so
// a long delegation is never abandoned mid-flight — which would look like a
// delegation failure and spawn a duplicate worker. `0` explicitly disables the
// cap; a non-numeric value falls back to the default.
const rawTimeout = process.env.CHORUS_DAEMON_CALL_TIMEOUT_MS;
const parsedTimeout = rawTimeout !== undefined && rawTimeout !== "" ? Number(rawTimeout) : Number.NaN;
const CALL_TIMEOUT_MS =
  Number.isFinite(parsedTimeout) && parsedTimeout >= 0 ? parsedTimeout : DEFAULT_CALL_TIMEOUT_MS;

const server = new McpServer({ name: "chorus", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: tool.input },
    async (args: Record<string, unknown>) => {
      const { ok, text } = await callDaemon(DAEMON_URL, TOKEN, tool.method, tool.path, args, CALL_TIMEOUT_MS);
      return { content: [{ type: "text", text }], isError: !ok };
    },
  );
}

await server.connect(new StdioServerTransport());
process.stderr.write(`[chorus-mcp] connected (daemon=${DAEMON_URL})\n`);
