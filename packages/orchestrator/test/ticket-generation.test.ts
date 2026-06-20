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
  type ChangelogEntry,
  type Project,
  type Ticket,
  type TicketEvent,
} from "@chorus/core";
import { ChorusDb } from "@chorus/db";
import { Orchestrator } from "../src/orchestrator.js";
import {
  buildIdleTicketPrompt,
  type IdleTicketDraft,
  type IdleTicketGenerationInput,
} from "../src/ticket-generation.js";

function freshDb(): ChorusDb {
  return new ChorusDb(join(mkdtempSync(join(tmpdir(), "chorus-idle-ticket-")), "test.db"));
}

function seedProject(db: ChorusDb, patch: Partial<Project> = {}): Project {
  const project: Project = {
    id: newId("proj"),
    repoUrl: "git@github.com:acme/widgets.git",
    localPath: mkdtempSync(join(tmpdir(), "chorus-idle-repo-")),
    baseBranch: "main",
    specPath: "SPEC.md",
    expectations: "Make the app more stable and useful for operators.",
    groundRules: ["Keep changes small"],
    setupCommand: "npm install",
    verifyCommands: ["npm test"],
    commandsDetected: true,
    status: "ready",
    runState: "running",
    idleIdeation: true,
    idleIdeationCount: 1,
    createdAt: Date.now(),
    ...patch,
  };
  db.insertProject(project);
  return project;
}

function seedTicket(db: ChorusDb, projectId: string, patch: Partial<Ticket> = {}): Ticket {
  const now = Date.now();
  const ticket: Ticket = {
    id: newId("tkt"),
    projectId,
    title: "Add dashboard filters",
    body: "Let operators filter tickets by status.",
    status: "closed",
    roleName: ORCHESTRATOR_ROLE,
    priority: 4,
    source: "manual",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
  db.insertTicket(ticket);
  return ticket;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(fn: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > 1000) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("buildIdleTicketPrompt includes project goal, prior activity, journal, changelog, and exactly-one guidance", () => {
  const now = Date.now();
  const project = {
    id: "proj_1",
    repoUrl: "owner/repo",
    localPath: "/tmp/repo",
    baseBranch: "main",
    specPath: "SPEC.md",
    expectations: "Evolve Chorus toward a more stable autonomous engineering team.",
    groundRules: ["No direct pushes to main"],
    setupCommand: "npm install",
    verifyCommands: ["npm run build", "npm test"],
    commandsDetected: true,
    status: "ready",
    runState: "running",
    createdAt: now,
  } as Project;
  const ticket = {
    id: "tkt_done",
    projectId: project.id,
    title: "Add cost tracking",
    body: "Track backend token usage in the dashboard.",
    status: "merged",
    roleName: ORCHESTRATOR_ROLE,
    priority: 3,
    source: "spec",
    branch: null,
    worktreePath: null,
    prUrl: null,
    prNumber: null,
    createdAt: now,
    updatedAt: now,
  } as Ticket;
  const recentEvent = {
    id: "te_1",
    projectId: project.id,
    ticketId: ticket.id,
    actor: "software-dev",
    kind: "work",
    message: "Implemented dashboard cost summary.",
    createdAt: now,
  } as TicketEvent;
  const journal = {
    id: "aj_1",
    taskId: "task_1",
    ticketId: ticket.id,
    projectId: project.id,
    attempt: 1,
    promptHash: "abc",
    diffHash: "def",
    verifyPassed: true,
    verifyOutput: "ok",
    diagnosis: null,
    nextAction: "open_pr",
    evaluatorVerdict: null,
    reviewerVerdict: null,
    proof: "checks passed",
    createdAt: now,
  } as AttemptJournalEntry;
  const changelog = {
    id: "cl_1",
    projectId: project.id,
    ticketId: ticket.id,
    prId: "pr_1",
    entry: "Added cost tracking",
    agentRole: ORCHESTRATOR_ROLE,
    createdAt: now,
  } as ChangelogEntry;

  const prompt = buildIdleTicketPrompt({
    project,
    tickets: [ticket],
    recentEvents: [recentEvent],
    attemptJournal: [journal],
    changelog: [changelog],
    specExcerpt: "Chorus should keep improving itself after finishing queued work.",
    artifactsDir: "/tmp/artifacts",
  });

  assert.match(prompt, /exactly ONE priority-1 ticket/i);
  assert.match(prompt, /Evolve Chorus toward a more stable autonomous engineering team/);
  assert.match(prompt, /Add cost tracking/);
  assert.match(prompt, /Implemented dashboard cost summary/);
  assert.match(prompt, /next=open_pr/);
  assert.match(prompt, /Added cost tracking/);
  assert.match(prompt, /keep improving itself/);
});

test("orchestrator still ideates when remaining tickets are only pr_open / blocked (no active work)", async () => {
  for (const status of ["pr_open", "blocked"] as const) {
    const db = freshDb();
    const project = seedProject(db, { idleIdeation: true, idleIdeationCount: 1 });
    seedTicket(db, project.id, { title: "Finished work", status: "merged" });
    seedTicket(db, project.id, { title: "Awaiting human", status });

    const calls: IdleTicketGenerationInput[] = [];
    const config = ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-idle-data-")) });
    const orchestrator = new Orchestrator({
      db,
      git: {} as never,
      backends: {} as never,
      notifier: { notify: async () => {} },
      bus: new ChorusBus(),
      config,
      idleTicketGenerator: async (input) => {
        calls.push(input);
        return { title: "Next idea", body: "Body.\n\nAcceptance criteria:\n- does the thing." };
      },
    });

    try {
      orchestrator.start();
      await waitFor(() => calls.length === 1, `ideation runs despite a ${status} ticket`);
      assert.equal(calls.length, 1);
    } finally {
      await orchestrator.stop();
      db.close();
    }
  }
});

test("orchestrator does not generate idle tickets while real work is queued (open ticket)", async () => {
  const db = freshDb();
  const project = seedProject(db, { idleIdeation: true, idleIdeationCount: 1 });
  seedTicket(db, project.id, { title: "Finished work", status: "merged" });
  seedTicket(db, project.id, { title: "Still queued", status: "open" });

  const calls: IdleTicketGenerationInput[] = [];
  const config = ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-idle-data-")) });
  const orchestrator = new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { notify: async () => {} },
    bus: new ChorusBus(),
    config,
    idleTicketGenerator: async (input) => {
      calls.push(input);
      return { title: "should not happen", body: "should not happen" };
    },
  });

  try {
    orchestrator.start();
    await orchestrator.tick();
    await orchestrator.tick();
    assert.equal(calls.length, 0, "no ideation while an open ticket is queued");
  } finally {
    await orchestrator.stop();
    db.close();
  }
});

test("orchestrator generates one priority-1 ticket when the queue drains and does not duplicate on repeated ticks", async () => {
  const db = freshDb();
  const project = seedProject(db);
  seedTicket(db, project.id, { title: "Completed setup", status: "merged" });

  const calls: IdleTicketGenerationInput[] = [];
  const gate = deferred<IdleTicketDraft>();
  const config = ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-idle-data-")) });
  const orchestrator = new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { notify: async () => {} },
    bus: new ChorusBus(),
    config,
    idleTicketGenerator: async (input) => {
      calls.push(input);
      return gate.promise;
    },
  });

  try {
    orchestrator.start();
    await waitFor(() => calls.length === 1, "first idle ticket generation call");

    await orchestrator.tick();
    await orchestrator.tick();
    assert.equal(calls.length, 1, "generation remains in-flight across repeated empty ticks");

    gate.resolve({
      title: "Add resilient scheduler telemetry",
      body: "Expose scheduler idle-generation decisions in the activity feed.\n\nAcceptance criteria:\n- A ticket event records the reason.\n- Repeated ticks do not duplicate events.",
    });
    await waitFor(
      () => db.listTickets(project.id).some((t) => t.title === "Add resilient scheduler telemetry"),
      "generated ticket insert",
    );

    assert.equal(calls.length, 1);
    const generated = db
      .listTickets(project.id)
      .filter((t) => t.title === "Add resilient scheduler telemetry");
    assert.equal(generated.length, 1);
    assert.equal(generated[0]?.priority, 1);
    assert.equal(generated[0]?.status, "open");
    assert.equal(generated[0]?.roleName, ORCHESTRATOR_ROLE);
    assert.equal(generated[0]?.source, "manual");
    assert.ok(
      db
        .listTicketEvents(generated[0]!.id)
        .some((e) => e.actor === "system" && /queue became empty/.test(e.message)),
    );
  } finally {
    await orchestrator.stop();
    db.close();
  }
});

test("orchestrator does not ideate when the toggle is off, even with a drained queue", async () => {
  const db = freshDb();
  const project = seedProject(db, { idleIdeation: false, idleIdeationCount: 3 });
  seedTicket(db, project.id, { title: "Completed setup", status: "merged" });

  const calls: IdleTicketGenerationInput[] = [];
  const config = ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-idle-data-")) });
  const orchestrator = new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { notify: async () => {} },
    bus: new ChorusBus(),
    config,
    idleTicketGenerator: async (input) => {
      calls.push(input);
      return { title: "should not happen", body: "should not happen" };
    },
  });

  try {
    orchestrator.start();
    await orchestrator.tick();
    await orchestrator.tick();
    assert.equal(calls.length, 0, "no generation while the toggle is off");
    assert.equal(db.listTickets(project.id).length, 1, "no new tickets created");
  } finally {
    await orchestrator.stop();
    db.close();
  }
});

test("orchestrator ideates exactly idleIdeationCount tickets in one drained pass", async () => {
  const db = freshDb();
  const project = seedProject(db, { idleIdeation: true, idleIdeationCount: 3 });
  seedTicket(db, project.id, { title: "Completed setup", status: "merged" });

  const calls: IdleTicketGenerationInput[] = [];
  const config = ConfigSchema.parse({ dataDir: mkdtempSync(join(tmpdir(), "chorus-idle-data-")) });
  const orchestrator = new Orchestrator({
    db,
    git: {} as never,
    backends: {} as never,
    notifier: { notify: async () => {} },
    bus: new ChorusBus(),
    config,
    idleTicketGenerator: async (input) => {
      const n = calls.push(input);
      return {
        title: `Idea ${n}`,
        body: `Body for idea ${n}.\n\nAcceptance criteria:\n- does the thing.`,
      };
    },
  });

  try {
    orchestrator.start();
    await waitFor(() => calls.length === 3, "three idle ticket generation calls");

    const generated = db.listTickets(project.id).filter((t) => /^Idea \d+$/.test(t.title));
    assert.equal(generated.length, 3, "exactly three tickets generated");
    assert.ok(generated.every((t) => t.priority === 1), "all generated tickets are priority 1");
    // The pass stops at the count; it does not keep generating forever.
    await orchestrator.tick();
    assert.equal(calls.length, 3, "generation does not exceed idleIdeationCount");
  } finally {
    await orchestrator.stop();
    db.close();
  }
});
