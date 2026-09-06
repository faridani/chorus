import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChorusBus,
  newId,
  ORCHESTRATOR_ROLE,
  TICKET_CLEANUP_CONFIRMATION,
  type Project,
  type Ticket,
} from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { AppController } from "../src/controller.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-cleanup-")), "t.db"));
}

function seedProject(db: ChorusDb): Project {
  const id = newId("proj");
  const project: Project = {
    id,
    repoUrl: "owner/repo",
    localPath: join(tmpdir(), "no-clone-" + id),
    baseBranch: "main",
    specPath: null,
    expectations: "",
    groundRules: [],
    setupCommand: null,
    verifyCommands: [],
    commandsDetected: true,
    status: "ready",
    runState: "running",
    idleIdeation: false,
    idleIdeationCount: 1,
    createdAt: Date.now(),
  };
  db.insertProject(project);
  return project;
}

function seedTicket(db: ChorusDb, projectId: string, patch: Partial<Ticket> = {}): Ticket {
  const now = Date.now();
  const ticket: Ticket = {
    id: newId("tkt"),
    projectId,
    title: patch.title ?? "Ticket",
    body: patch.body ?? "Body",
    status: patch.status ?? "open",
    roleName: patch.roleName ?? ORCHESTRATOR_ROLE,
    priority: patch.priority ?? 0,
    source: patch.source ?? "manual",
    branch: patch.branch ?? null,
    worktreePath: patch.worktreePath ?? null,
    prUrl: patch.prUrl ?? null,
    prNumber: patch.prNumber ?? null,
    starred: patch.starred ?? false,
    createdAt: now,
    updatedAt: now,
  };
  db.insertTicket(ticket);
  return ticket;
}

function makeController(
  db: ChorusDb,
  git: {
    closePullRequest?: (localPath: string, ref: string) => Promise<boolean>;
    removeWorktree?: (localPath: string, worktreePath: string) => Promise<void>;
    deleteBranch?: (localPath: string, branch: string) => Promise<boolean>;
  } = {},
  runningTaskIds: string[] = [],
): AppController {
  return new AppController({
    db,
    bus: new ChorusBus(),
    git: {
      closePullRequest: async () => false,
      removeWorktree: async () => {},
      deleteBranch: async () => false,
      ...git,
    } as never,
    backends: {} as never,
    orchestrator: { runningTaskIds: () => runningTaskIds, tick: () => {} } as never,
    notifier: {} as never,
    config: { dataDir: "/tmp", agent: {} } as never,
    detectedBackends: [],
  });
}

test("cleanupTickets deletes all idle tickets", async () => {
  const db = freshDb();
  const project = seedProject(db);
  seedTicket(db, project.id);
  seedTicket(db, project.id);
  const ctrl = makeController(db);

  const result = await ctrl.cleanupTickets(project.id, { confirmation: TICKET_CLEANUP_CONFIRMATION });

  assert.deepEqual(result, { deletedTickets: 2, closedPullRequests: 0, removedBranches: 0 });
  assert.equal(db.listTickets(project.id).length, 0);
  db.close();
});

test("cleanupTickets requires exact DELETE confirmation before destructive work", async () => {
  const db = freshDb();
  const project = seedProject(db);
  seedTicket(db, project.id, {
    branch: "chorus/ticket-one",
    worktreePath: "/tmp/worktree-one",
    prUrl: "https://github.com/owner/repo/pull/12",
  });
  const calls = { prs: [] as string[], worktrees: [] as string[], branches: [] as string[] };
  const ctrl = makeController(db, {
    closePullRequest: async (_localPath, ref) => {
      calls.prs.push(ref);
      return true;
    },
    removeWorktree: async (_localPath, worktreePath) => {
      calls.worktrees.push(worktreePath);
    },
    deleteBranch: async (_localPath, branch) => {
      calls.branches.push(branch);
      return true;
    },
  });

  await assert.rejects(
    () => ctrl.cleanupTickets(project.id, { removeBranches: true, removePullRequests: true } as never),
    /Type DELETE to clean up tickets/,
  );
  await assert.rejects(
    () =>
      ctrl.cleanupTickets(project.id, {
        confirmation: "DELETE ",
        removeBranches: true,
        removePullRequests: true,
      }),
    /Type DELETE to clean up tickets/,
  );

  assert.equal(db.listTickets(project.id).length, 1);
  assert.deepEqual(calls, { prs: [], worktrees: [], branches: [] });
  db.close();
});

test("cleanupTickets optionally closes PRs and removes ticket branches", async () => {
  const db = freshDb();
  const project = seedProject(db);
  const t1 = seedTicket(db, project.id, {
    branch: "chorus/ticket-one",
    worktreePath: "/tmp/worktree-one",
    prUrl: "https://github.com/owner/repo/pull/12",
    prNumber: 12,
    status: "pr_open",
  });
  const t2 = seedTicket(db, project.id);
  db.insertTask({
    id: newId("task"),
    ticketId: t2.id,
    projectId: project.id,
    backendId: "codex",
    worktreePath: "/tmp/worktree-two",
    branch: "chorus/scratch-two",
    baseCommit: "base",
    state: "merged",
    attempt: 1,
    resumeAt: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
  });

  const calls = { prs: [] as string[], worktrees: [] as string[], branches: [] as string[] };
  const ctrl = makeController(db, {
    closePullRequest: async (_localPath, ref) => {
      calls.prs.push(ref);
      return ref.startsWith("https://");
    },
    removeWorktree: async (_localPath, worktreePath) => {
      calls.worktrees.push(worktreePath);
    },
    deleteBranch: async (_localPath, branch) => {
      calls.branches.push(branch);
      return true;
    },
  });

  const result = await ctrl.cleanupTickets(project.id, {
    confirmation: TICKET_CLEANUP_CONFIRMATION,
    removeBranches: true,
    removePullRequests: true,
  });

  assert.deepEqual(result, { deletedTickets: 2, closedPullRequests: 1, removedBranches: 2 });
  assert.deepEqual(calls.prs, ["https://github.com/owner/repo/pull/12"]);
  assert.deepEqual(calls.worktrees, ["/tmp/worktree-one"]);
  assert.deepEqual(calls.branches.sort(), ["chorus/scratch-two", "chorus/ticket-one"]);
  assert.equal(db.listTickets(project.id).length, 0);
  assert.equal(db.listTasksForTicket(t1.id).length, 0);
  assert.equal(db.listTasksForTicket(t2.id).length, 0);
  db.close();
});

test("cleanupTickets only removes Chorus-owned work branches", async () => {
  const db = freshDb();
  const project = seedProject(db);
  const t1 = seedTicket(db, project.id, { branch: "feature/shared", worktreePath: "/tmp/worktree-one" });
  const t2 = seedTicket(db, project.id, { branch: "chorus/ticket-two", worktreePath: "/tmp/worktree-two" });
  db.insertTask({
    id: newId("task"),
    ticketId: t1.id,
    projectId: project.id,
    backendId: "codex",
    worktreePath: "/tmp/task-worktree",
    branch: "release/shared",
    baseCommit: "base",
    state: "merged",
    attempt: 1,
    resumeAt: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
  });
  db.insertTask({
    id: newId("task"),
    ticketId: t2.id,
    projectId: project.id,
    backendId: "codex",
    worktreePath: "/tmp/task-worktree",
    branch: "chorus/task-two",
    baseCommit: "base",
    state: "merged",
    attempt: 1,
    resumeAt: null,
    startedAt: Date.now(),
    endedAt: Date.now(),
  });

  const calls = { worktrees: [] as string[], branches: [] as string[] };
  const ctrl = makeController(db, {
    removeWorktree: async (_localPath, worktreePath) => {
      calls.worktrees.push(worktreePath);
    },
    deleteBranch: async (_localPath, branch) => {
      calls.branches.push(branch);
      return true;
    },
  });

  const result = await ctrl.cleanupTickets(project.id, {
    confirmation: TICKET_CLEANUP_CONFIRMATION,
    removeBranches: true,
  });

  assert.deepEqual(result, { deletedTickets: 2, closedPullRequests: 0, removedBranches: 2 });
  assert.deepEqual(calls.worktrees, ["/tmp/worktree-one", "/tmp/worktree-two"]);
  assert.deepEqual(calls.branches.sort(), ["chorus/task-two", "chorus/ticket-two"]);
  assert.equal(db.listTickets(project.id).length, 0);
  db.close();
});

test("cleanupTickets rejects while any project ticket is actively running", async () => {
  const db = freshDb();
  const project = seedProject(db);
  const ticket = seedTicket(db, project.id, { branch: "chorus/ticket-running" });
  const calls: string[] = [];
  const ctrl = makeController(
    db,
    {
      deleteBranch: async (_localPath, branch) => {
        calls.push(branch);
        return true;
      },
    },
    [ticket.id],
  );

  await assert.rejects(
    () =>
      ctrl.cleanupTickets(project.id, {
        confirmation: TICKET_CLEANUP_CONFIRMATION,
        removeBranches: true,
      }),
    /Cannot clean up tickets while an agent is running/,
  );
  assert.equal(db.listTickets(project.id).length, 1);
  assert.deepEqual(calls, []);
  db.close();
});
