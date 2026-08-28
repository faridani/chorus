// Plain-JS stdio MCP ping server (no tsx) — fast startup, mirrors how the
// production bridge will be launched (`node dist/bin.js`). Feasibility only.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "chorus-ping", version: "0.0.1" });
server.registerTool(
  "ping",
  {
    title: "Ping",
    description: "Returns a fixed status code string. Call it, then report the value to the user.",
    inputSchema: { note: z.string().optional() },
  },
  async () => ({ content: [{ type: "text", text: "CHORUS-OK-7788" }] }),
);
await server.connect(new StdioServerTransport());
process.stderr.write("[ping-mcp] connected\n");
