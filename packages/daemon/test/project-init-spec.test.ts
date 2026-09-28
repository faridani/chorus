import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { ChorusBus, newId, ORCHESTRATOR_ROLE, type NotificationEvent, type Project } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { AppController } from "../src/controller.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(process.cwd(), prefix));
  tempDirs.push(dir);
  return dir;
}

const databases: ChorusDb[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): ChorusDb {
  const db = new ChorusDb(join(tempDir("chorus-init-"), "t.db"));
  databases.push(db);
  return db;
}

function writeRepoFile(repo: string, rel: string, content = "content\n"): void {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), content, "utf8");
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function makeController(
  db: ChorusDb,
  opts: {
    seedClone?: (localPath: string) => void;
    notifications?: NotificationEvent[];
    ingestCalls?: Project[];
    dataDir?: string;
  } = {},
): AppController {
  const dataDir = opts.dataDir ?? tempDir("chorus-init-data-");
  return new AppController({
    db,
    bus: new ChorusBus(),
    git: {
      clone: async (_repoUrl: string, localPath: string) => {
        mkdirSync(localPath, { recursive: true });
        opts.seedClone?.(localPath);
      },
      detectDefaultBranch: async () => "main",
      installPushGuard: async () => {},
      commitFile: async () => "commit",
    } as never,
    backends: {} as never,
    orchestrator: { runningTaskIds: () => [], tick: () => {} } as never,
    notifier: {
      id: "test",
      notify: async (event: NotificationEvent) => {
        opts.notifications?.push(event);
      },
    },
    config: { dataDir, agent: {} } as never,
    detectedBackends: [],
    ingestor: {
      ingest: async (project) => {
        opts.ingestCalls?.push(project);
        const ticket = {
          id: newId("tkt"),
          projectId: project.id,
          title: "Generated ticket",
          body: "Generated from spec.",
          status: "open" as const,
          roleName: ORCHESTRATOR_ROLE,
          priority: 0,
          source: "spec" as const,
          branch: null,
          worktreePath: null,
          prUrl: null,
          prNumber: null,
          starred: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        db.insertTicket(ticket);
        return [ticket];
      },
    },
  });
}

test("createProject with only README enters needs_spec and does not ingest tickets", async () => {
  const db = freshDb();
  const notifications: NotificationEvent[] = [];
  const ingestCalls: Project[] = [];
  const ctrl = makeController(db, {
    notifications,
    ingestCalls,
    seedClone: (localPath) => writeRepoFile(localPath, "README.md", "# README\n"),
  });

  const created = await ctrl.createProject({ repoUrl: "owner/readme-only" });
  await waitFor(() => db.getProject(created.id)?.status === "needs_spec", "README-only project should request a spec");

  const project = db.getProject(created.id)!;
  assert.equal(project.specPath, null);
  assert.equal(ingestCalls.length, 0);
  assert.deepEqual(db.listTickets(created.id), []);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.kind, "needs_review");
  assert.equal(notifications[0]?.projectId, created.id);
  assert.equal(notifications[0]?.title, "Project needs a spec");
  assert.match(notifications[0]?.body ?? "", /no spec or architecture file/);
});

test("createProject with a conventional spec becomes ready and ingests tickets", async () => {
  const db = freshDb();
  const ingestCalls: Project[] = [];
  const ctrl = makeController(db, {
    ingestCalls,
    seedClone: (localPath) => {
      writeRepoFile(localPath, "README.md", "# README\n");
      writeRepoFile(localPath, "docs/ARCHITECTURE.md", "# Architecture\n");
    },
  });

  const created = await ctrl.createProject({ repoUrl: "owner/with-spec" });
  await waitFor(() => db.getProject(created.id)?.status === "ready" && ingestCalls.length === 1, "project should become ready and ingest its spec");

  const project = db.getProject(created.id)!;
  assert.equal(project.specPath, "docs/ARCHITECTURE.md");
  assert.equal(db.listTickets(created.id).length, 1);
  assert.equal(ingestCalls[0]?.specPath, "docs/ARCHITECTURE.md");
});

test("createProject with pasted spec writes docs/SPEC.md and ingests tickets", async () => {
  const db = freshDb();
  const ingestCalls: Project[] = [];
  const specText = "# Pasted spec\n\nBuild the product.\n";
  const ctrl = makeController(db, {
    ingestCalls,
    seedClone: (localPath) => writeRepoFile(localPath, "README.md", "# README\n"),
  });

  const created = await ctrl.createProject({ repoUrl: "owner/pasted-spec", specText });
  await waitFor(() => db.getProject(created.id)?.status === "ready" && ingestCalls.length === 1, "project should become ready and ingest its spec");

  const project = db.getProject(created.id)!;
  assert.equal(project.specPath, "docs/SPEC.md");
  assert.equal(readFileSync(join(project.localPath, "docs/SPEC.md"), "utf8"), specText);
  assert.equal(db.listTickets(created.id).length, 1);
});

test("provideSpec writes docs/SPEC.md, marks ready, and ingests tickets", async () => {
  const db = freshDb();
  const ingestCalls: Project[] = [];
  const dataDir = tempDir("chorus-provide-data-");
  const localPath = join(dataDir, "repos", "proj_manual");
  mkdirSync(localPath, { recursive: true });
  const project: Project = {
    id: newId("proj"),
    repoUrl: "owner/manual-spec",
    localPath,
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: true,
    status: "needs_spec",
    runState: "running",
    idleIdeation: false,
    idleIdeationCount: 1,
    createdAt: Date.now(),
  };
  db.insertProject(project);
  const ctrl = makeController(db, { ingestCalls, dataDir });
  const specText = "# Provided spec\n";

  await ctrl.provideSpec(project.id, specText);

  const updated = db.getProject(project.id)!;
  assert.equal(updated.status, "ready");
  assert.equal(updated.specPath, "docs/SPEC.md");
  assert.equal(readFileSync(join(localPath, "docs/SPEC.md"), "utf8"), specText);
  assert.equal(db.listTickets(project.id).length, 1);
  assert.equal(ingestCalls[0]?.specPath, "docs/SPEC.md");
});
