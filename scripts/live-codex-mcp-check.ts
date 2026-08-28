/**
 * Feasibility gate for LLM-driven orchestration: prove that `codex exec` can
 * discover, call, and use a stdio MCP tool turn-by-turn. Mirrors the style of
 * live-codex-check.ts. Requires a logged-in Codex CLI; talks to the real model.
 *
 * Run:  npx tsx scripts/live-codex-mcp-check.ts
 * Exits non-zero (and prints why) if codex did not call the ping tool or did
 * not surface the secret it returned.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

// Neutral value + prompt: earlier wording like "secret token" intermittently
// tripped codex's cybersecurity moderation filter (a prompt artifact, not an
// MCP limitation). Launch via `node` (fast startup) to mirror the real bridge.
const SECRET = "CHORUS-OK-7788";
const pingServer = join(import.meta.dirname, "ping-mcp-server.mjs");

const args = [
  "exec",
  "--json",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "-c",
  `mcp_servers.ping.command="node"`,
  "-c",
  `mcp_servers.ping.args=["${pingServer}"]`,
  "Call the ping tool with no arguments. Then report the exact text value it returns.",
];

console.log(`$ codex ${args.join(" ")}\n`);
const proc = spawn("codex", args, { stdio: ["ignore", "pipe", "pipe"] });

let stdout = "";
proc.stdout.on("data", (d: Buffer) => {
  stdout += d.toString();
});
proc.stderr.on("data", (d: Buffer) => {
  const s = d.toString();
  if (/error|mcp|ping/i.test(s)) process.stderr.write(s);
});

proc.on("close", (code) => {
  const lines = stdout.split("\n").filter(Boolean);
  let calledPing = false;
  let gotSecret = false;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      const item = ev.item ?? ev.msg ?? ev;
      if (item?.type === "mcp_tool_call" && item?.tool === "ping") {
        calledPing = true;
        const text = item?.result?.content?.map((c: { text?: string }) => c.text).join("") ?? "";
        if (text.includes(SECRET)) gotSecret = true;
      }
    } catch {
      // non-JSON line; ignore
    }
  }
  const reportedSecret = stdout.includes(SECRET);

  console.log("\n--- feasibility verdict ---");
  console.log(`codex exit code:           ${code} (non-zero is OK; codex often exits 1 after final output)`);
  console.log(`called ping MCP tool:      ${calledPing}`);
  console.log(`tool returned the secret:  ${gotSecret}`);
  console.log(`secret surfaced in output: ${reportedSecret}`);

  if (calledPing && (gotSecret || reportedSecret)) {
    console.log("\n✅ PASS: codex drives a stdio MCP server turn-by-turn.");
    process.exit(0);
  }
  console.error("\n❌ FAIL: codex did not call the MCP tool / use its result. Reconsider transport or backend.");
  process.exit(1);
});
