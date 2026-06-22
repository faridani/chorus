import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChorusBus, ConfigSchema, newId, ORCHESTRATOR_ROLE, type Project, type Ticket } from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { Orchestrator } from "../src/orchestrator.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-pr-poll-")), "test.db"));
}

function seedProject(db: ChorusDb): Project {
  const project: Project = {
    id: newId("proj"),
    repoUrl: "git@github.com:acme/widgets.git",
    localPath: mkdtempSync(join(tmpdir(), "chorus-pr-repo-")),
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

function seedPrTicket(db: ChorusDb, projectId: string, prNumber: number): Ticket {
  const now = Date.now();
  const ticket: Ticket = {
    id: newId("tkt"),
    projectId,
    title: `Review PR ${prNumber}`,
    body: "Await human review.",
    status: "pr_open",
    roleName: ORCHESTRATOR_ROLE,
    priority: 0,
    source: "manual",
    branch: `chorus/ticket-${prNumber}`,
    worktreePath: null,
    prUrl: `https://github.com/acme/widgets/pull/${prNumber}`,
    prNumber,
    starred: false,
    createdAt: now,
    updatedAt: now,
  };
  db.insertTicket(ticket);
  db.insertPullRequest({
    id: newId("pr"),
    ticketId: ticket.id,
    projectId,
    taskId: null,
    url: ticket.prUrl,
    number: prNumber,
    state: "OPEN",
    createdAt: now,
    updatedAt: now,
  });
  return ticket;
}

async function pollWithGitState(
  db: ChorusDb,
  state: { url: string; number: number | null; state: string; mergedAt: string | null },
): Promise<void> {
  const orchestrator = new Orchestrator({
    db,
    git: {
      getPrState: async () => state,
      removeWorktree: async () => {},
    } as never,
    backends: {} as never,
    notifier: { id: "test", notify: async () => {} },
    bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-pr-data-")) }),
  });

  await (orchestrator as unknown as { pollOpenPrs(): Promise<void> }).pollOpenPrs();
}

test("pollOpenPrs persists MERGED for a previously OPEN pull request", async () => {
  const db = freshDb();
  const project = seedProject(db);
  const ticket = seedPrTicket(db, project.id, 60);

  await pollWithGitState(db, {
    url: ticket.prUrl!,
    number: ticket.prNumber,
    state: "MERGED",
    mergedAt: "2026-06-21T12:00:00Z",
  });

  assert.equal(db.getTicket(ticket.id)?.status, "merged");
  assert.equal(db.listPullRequests(project.id).find((p) => p.number === 60)?.state, "MERGED");
  assert.equal(db.listOpenPullRequests(project.id).length, 0);
  db.close();
});

test("pollOpenPrs persists CLOSED when a pull request is closed without merging", async () => {
  const db = freshDb();
  const project = seedProject(db);
  const ticket = seedPrTicket(db, project.id, 41);

  await pollWithGitState(db, {
    url: ticket.prUrl!,
    number: ticket.prNumber,
    state: "CLOSED",
    mergedAt: null,
  });

  const reopened = db.getTicket(ticket.id);
  assert.equal(reopened?.status, "open");
  assert.equal(reopened?.roleName, ORCHESTRATOR_ROLE);
  assert.equal(reopened?.branch, null);
  assert.equal(db.listPullRequests(project.id).find((p) => p.number === 41)?.state, "CLOSED");
  assert.equal(db.listOpenPullRequests(project.id).length, 0);
  db.close();
});
