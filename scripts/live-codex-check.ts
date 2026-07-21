/**
 * Live integration check for the real Codex CLI (spends a small amount of
 * subscription quota). Drives CodexBackend against a throwaway LOCAL git repo
 * with a trivial task and asserts the full contract:
 *   - codex exec --json streams events we can parse
 *   - the --output-schema result file is produced and valid
 *   - the agent makes a real commit in its isolated worktree
 *
 * Run: npx tsx scripts/live-codex-check.ts
 */
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexBackend, CodexQuotaPolicy } from "@chorus/backends";
import { GitService } from "@chorus/git-service";
import { run } from "@chorus/proc";

async function git(cwd: string, ...args: string[]) {
  const r = await run("git", args, { cwd, throwOnError: true });
  return r.stdout.trim();
}

async function main() {
  const repo = mkdtempSync(join(tmpdir(), "chorus-live-"));
  console.log(`[live] repo: ${repo}`);
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "agent@chorus.dev");
  await git(repo, "config", "user.name", "Chorus Agent");
  await run("bash", ["-c", `echo "# Live check" > "${join(repo, "README.md")}"`]);
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "checkout", "-q", "-b", "chorus/integration");

  const gs = new GitService();
  const base = await gs.headCommit(repo, "chorus/integration");
  const wt = join(repo, "..", `live-wt-${Date.now()}`);
  await gs.addWorktree(repo, wt, "chorus/ticket-live", "chorus/integration");
  console.log(`[live] worktree: ${wt}`);

  const backend = new CodexBackend({
    quotaPolicy: new CodexQuotaPolicy({
      exhaustionPatterns: ["rate.?limit", "quota", "\\b429\\b"],
      backoffStartMs: 1000,
      backoffMaxMs: 1000,
    }),
  });

  const handle = backend.startRun({
    taskId: "live-1",
    prompt:
      "Create a file named hello.txt containing exactly the text 'hello from chorus'. " +
      "Then commit it with git (the working directory is already a git repo). " +
      "Keep it minimal. When done, return the required JSON result.",
    worktreePath: wt,
    artifactsDir: join(repo, "..", `live-artifacts-${Date.now()}`),
    maxWallClockMs: 5 * 60 * 1000,
    idleTimeoutMs: 2 * 60 * 1000,
  });

  console.log(`[live] codex pid=${handle.pid} pgid=${handle.pgid}`);
  let eventCount = 0;
  const drain = (async () => {
    for await (const ev of handle.events) {
      eventCount++;
      let detail = "";
      if (ev.kind === "reasoning") detail = ev.text;
      else if (ev.kind === "message") detail = ev.text;
      else if (ev.kind === "command") detail = ev.command;
      else if (ev.kind === "file_change") detail = ev.files.join(", ");
      else if (ev.kind === "plan") detail = `${ev.items.length} items`;
      if (detail) process.stdout.write(`  · ${ev.kind}: ${detail.slice(0, 80)}\n`);
    }
  })();

  const [result] = await Promise.all([handle.result, drain]);

  console.log("\n[live] === RESULT ===");
  console.log(`terminalReason: ${result.terminalReason}`);
  console.log(`exitCode:       ${result.exitCode}`);
  console.log(`events seen:    ${eventCount}`);
  console.log(`usage:          ${JSON.stringify(result.usage)}`);
  console.log(`payload:        ${JSON.stringify(result.payload)}`);

  // Assertions mirroring orchestrator done-detection.
  const hasCommits = await gs.hasNewCommits(repo, base, "chorus/ticket-live");
  const clean = await gs.isWorktreeClean(wt);
  const fileExists = existsSync(join(wt, "hello.txt"));

  console.log("\n[live] === CHECKS ===");
  const checks: Array<[string, boolean]> = [
    ["terminalReason === completed", result.terminalReason === "completed"],
    ["structured payload present", result.payload !== null],
    ["payload.status === success", result.payload?.status === "success"],
    ["new commit on branch", hasCommits],
    ["worktree clean", clean],
    ["hello.txt exists", fileExists],
  ];
  let allOk = true;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "✅" : "❌"} ${name}`);
    if (!ok) allOk = false;
  }
  console.log(`\n[live] raw log: ${result.rawLogPath}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("[live] error:", err);
  process.exit(1);
});
