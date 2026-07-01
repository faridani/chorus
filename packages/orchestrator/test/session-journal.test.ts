import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChorusBus,
  ConfigSchema,
  newId,
  ORCHESTRATOR_ROLE,
  type AttemptJournalEntry,
  type Project,
  type Ticket,
} from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import type { SessionState } from "../src/autonomous.js";
import { Orchestrator } from "../src/orchestrator.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-session-journal-")), "test.db"));
}

function seedProject(db: ChorusDb): Project {
  const project: Project = {
    id: newId("proj"),
    repoUrl: "git@github.com:acme/widgets.git",
    localPath: mkdtempSync(join(tmpdir(), "chorus-session-journal-repo-")),
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

function seedTicket(db: ChorusDb, projectId: string): Ticket {
  const now = Date.now();
  const ticket: Ticket = {
    id: newId("tkt"),
    projectId,
    title: "Make attempt journal callable",
    body: "Expose read/write tools.",
    status: "open",
    roleName: ORCHESTRATOR_ROLE,
    priority: 1,
    source: "manual",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
    starred: false,
    createdAt: now,
    updatedAt: now,
  };
  db.insertTicket(ticket);
  return ticket;
}

function makeOrchestrator(db: ChorusDb): Orchestrator {
  return new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { notify: async () => {} } as never,
    bus: new ChorusBus(),
    config: ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-session-journal-data-")) }),
  });
}

function attachSession(orchestrator: Orchestrator, project: Project, ticket: Ticket, token: string): void {
  const sessions = (orchestrator as unknown as { sessions: Map<string, SessionState> }).sessions;
  sessions.set(token, {
    token,
    projectId: project.id,
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    worktrees: new Map(),
    spokeCount: 0,
    running: 0,
    createdAt: Date.now(),
    finished: null,
    prUrl: null,
    handles: new Set(),
  });
}

function insertJournal(db: ChorusDb, projectId: string, ticketId: string, attempt = 1): AttemptJournalEntry {
  const entry: AttemptJournalEntry = {
    id: newId("aj"),
    taskId: newId("task"),
    ticketId,
    projectId,
    attempt,
    promptHash: null,
    diffHash: null,
    verifyPassed: false,
    verifyOutput: "npm test failed",
    diagnosis: "existing failure",
    nextAction: "retry",
    evaluatorVerdict: null,
    reviewerVerdict: null,
    proof: null,
    createdAt: Date.now(),
  };
  db.insertAttemptJournal(entry);
  return entry;
}

test("sessionCall writes and reads attempt-journal entries for the active session ticket", async () => {
  const db = freshDb();
  try {
    const project = seedProject(db);
    const ticket = seedTicket(db, project.id);
    const orchestrator = makeOrchestrator(db);
    attachSession(orchestrator, project, ticket, "tok-session");

    const longVerification = `${"passed ".repeat(2500)}\u0000tail`;
    const write = await orchestrator.sessionCall("tok-session", "attempt_journal.write", {
      projectId: "proj_attacker",
      ticketId: "tkt_attacker",
      verification: longVerification,
      verifyPassed: true,
      diagnosis: "Ready\r\nfor review\u0007",
      proof: "branch chorus/tkt/session-journal commit abc123",
      nextAction: "open_pr",
    });

    assert.equal(write.status, 200);
    const entry = (write.body as { entry: AttemptJournalEntry }).entry;
    assert.equal(entry.projectId, project.id);
    assert.equal(entry.ticketId, ticket.id);
    assert.equal(entry.verifyPassed, true);
    assert.equal(entry.nextAction, "open_pr");

    const projectJournal = db.listProjectAttemptJournal(project.id);
    assert.equal(projectJournal.length, 1);
    assert.equal(projectJournal[0]?.id, entry.id);
    assert.equal(projectJournal[0]?.diagnosis, "Ready\nfor review");
    assert.ok(projectJournal[0]?.verifyOutput);
    assert.equal(projectJournal[0]?.verifyOutput?.includes("\u0000"), false);
    assert.ok(projectJournal[0]!.verifyOutput!.length <= 12_000);
    assert.match(projectJournal[0]!.verifyOutput!, /\[truncated\]$/);

    const read = await orchestrator.sessionCall("tok-session", "attempt_journal.read", { limit: 5 });
    assert.equal(read.status, 200);
    const entries = (read.body as { entries: AttemptJournalEntry[] }).entries;
    assert.deepEqual(
      entries.map((e) => e.id),
      [entry.id],
    );
  } finally {
    db.close();
  }
});

test("sessionCall ignores caller-supplied journal projectId and ticketId", async () => {
  const db = freshDb();
  try {
    const project = seedProject(db);
    const ticket = seedTicket(db, project.id);
    const otherProject = seedProject(db);
    const otherTicket = seedTicket(db, otherProject.id);
    const otherEntry = insertJournal(db, otherProject.id, otherTicket.id);

    const orchestrator = makeOrchestrator(db);
    attachSession(orchestrator, project, ticket, "tok-scoped");

    const readOther = await orchestrator.sessionCall("tok-scoped", "attempt_journal.read", {
      projectId: otherProject.id,
      ticketId: otherTicket.id,
      limit: 10,
    });
    assert.equal(readOther.status, 200);
    assert.deepEqual((readOther.body as { entries: AttemptJournalEntry[] }).entries, []);

    const writeOther = await orchestrator.sessionCall("tok-scoped", "attempt_journal.write", {
      projectId: otherProject.id,
      ticketId: otherTicket.id,
      verification: "manual check passed",
      verifyPassed: true,
      nextAction: "finish",
    });
    assert.equal(writeOther.status, 200);

    const currentRows = db.listAttemptJournal(ticket.id);
    const otherRows = db.listAttemptJournal(otherTicket.id);
    assert.equal(currentRows.length, 1);
    assert.equal(currentRows[0]?.projectId, project.id);
    assert.equal(currentRows[0]?.ticketId, ticket.id);
    assert.deepEqual(
      otherRows.map((e) => e.id),
      [otherEntry.id],
    );
  } finally {
    db.close();
  }
});
