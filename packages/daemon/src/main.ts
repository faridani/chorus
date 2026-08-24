import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VersionInfo } from "@chorus/web";
import {
  BackendRegistry,
  ClaudeBackend,
  CodexBackend,
  CodexQuotaPolicy,
  GeminiBackend,
} from "@chorus/backends";
import { ChorusBus, loadBuiltInAgentTemplates, type Notifier } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { GitService } from "@chorus/git-service";
import { CompositeNotifier, IMessageNotifier, NullNotifier } from "@chorus/notifier";
import { Orchestrator, Reconciler } from "@chorus/orchestrator";
import { createServer } from "@chorus/web";
import { detectBackends } from "./backend-detect.js";
import { loadConfig } from "./config.js";
import { AppController } from "./controller.js";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });
  console.log(`[chorus] data dir: ${config.dataDir}`);

  const db = new ChorusDb(join(config.dataDir, "chorus.db"));
  const bus = new ChorusBus();
  const git = new GitService();
  const builtInAgents = loadBuiltInAgentTemplates();
  console.log(`[chorus] built-in agents: ${builtInAgents.length}`);

  // Backends.
  const backends = new BackendRegistry();
  const quotaPolicy = new CodexQuotaPolicy({
    exhaustionPatterns: config.quota.exhaustionPatterns,
    backoffStartMs: config.quota.backoffStartMs,
    backoffMaxMs: config.quota.backoffMaxMs,
  });
  backends.register(
    new CodexBackend({
      quotaPolicy,
      defaultModel: config.agent.model,
      reasoningSummary: config.agent.reasoningSummary,
    }),
  );
  backends.register(new ClaudeBackend({ quotaPolicy }));
  backends.register(new GeminiBackend({ quotaPolicy }));

  // Notifier.
  const notifier = buildNotifier(config);

  // Orchestrator.
  const orchestrator = new Orchestrator({ db, git, backends, notifier, bus, config });

  // Boot reconciliation BEFORE accepting work or starting the loop.
  await new Reconciler(db, git).reconcile();

  // Probe the host for available backend CLIs + their models.
  const detectedBackends = await detectBackends();
  console.log(
    `[chorus] backends: ${detectedBackends
      .map((b) => `${b.id}${b.available ? `(${b.version ?? "ok"})` : "(absent)"}`)
      .join(", ")}`,
  );

  const controller = new AppController({
    db,
    git,
    backends,
    orchestrator,
    notifier,
    bus,
    config,
    detectedBackends,
  });
  controller.ensureProjectAgents(); // backfill the orchestrator agent for existing projects
  controller.backfillProjectCommands(); // backfill setup/verify commands for older projects
  await controller.reinstallPushGuards(); // self-heal stale/broken pre-push hooks on older clones

  // Web + dashboard.
  const version = resolveVersion();
  console.log(`[chorus] version ${version.number} (${version.commit}${version.dirty ? "-dirty" : ""})`);
  const app = createServer({
    db,
    bus,
    api: controller,
    config,
    version,
    dashboardDir: resolveDashboardDir(),
  });
  await app.listen({ host: config.host, port: config.port });
  console.log(`[chorus] dashboard on http://${config.host}:${config.port}`);

  // Start dispatching.
  orchestrator.start();

  // Graceful shutdown.
  const shutdown = async (sig: string) => {
    console.log(`[chorus] ${sig} — shutting down`);
    try {
      await orchestrator.stop();
      await app.close();
      db.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

function buildNotifier(config: ReturnType<typeof loadConfig>): Notifier {
  if (!config.notifications.enabled || !config.notifications.imessageTo) {
    return new NullNotifier();
  }
  return new CompositeNotifier([new IMessageNotifier(config.notifications.imessageTo)]);
}

/** Repo root, relative to this file (works from both dist and tsx/src). */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", ".."); // packages/daemon/{dist,src} → repo root
}

/**
 * Version of the live build: package version + git commit captured at startup.
 * Since the daemon is restarted on deploy, startup-time HEAD reflects the
 * running code. `startedAt` lets you confirm a restart actually took effect.
 */
function resolveVersion(): VersionInfo {
  const root = repoRoot();
  let number = "0.0.0";
  try {
    number = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string) ?? number;
  } catch {
    /* ignore */
  }
  let commit = "unknown";
  let dirty = false;
  try {
    commit = execFileSync("git", ["-C", root, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
    }).trim();
    dirty =
      execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  } catch {
    /* not a git checkout */
  }
  return { number, commit, dirty, startedAt: Date.now() };
}

/** Locate the built dashboard SPA, if present. */
function resolveDashboardDir(): string | undefined {
  if (process.env.CHORUS_DASHBOARD_DIR) return process.env.CHORUS_DASHBOARD_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist: packages/daemon/dist → repo root is ../../..; src (tsx): packages/daemon/src → ../../..
  const candidates = [
    join(here, "..", "..", "..", "apps", "dashboard", "dist"),
    join(here, "..", "..", "..", "..", "apps", "dashboard", "dist"),
  ];
  return candidates.find((c) => existsSync(c));
}

main().catch((err) => {
  console.error("[chorus] fatal:", err);
  process.exit(1);
});
