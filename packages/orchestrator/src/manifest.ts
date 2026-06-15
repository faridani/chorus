import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptJournalEntry, Project, Ticket, TicketEvent } from "@chorus/core";

/**
 * A structured, durable bundle of everything a worker needs to do (and verify)
 * one attempt: acceptance criteria, the exact commands to run, related files,
 * evidence of what failed last time, and recent history. Written to disk per
 * attempt and rendered into the worker prompt.
 */
export interface TaskManifest {
  ticketId: string;
  ticketTitle: string;
  attempt: number;
  acceptanceCriteria: string[];
  setupCommand: string | null;
  verifyCommands: string[];
  relatedFiles: string[];
  /** Last attempt's failing verify output + diagnosis, if any. */
  issueEvidence: string | null;
  recentCommits: string[];
  trail: { actor: string; kind: string; message: string }[];
}

const MAX_RELATED_FILES = 30;

/** Pull acceptance-criteria-ish lines out of a ticket body (best effort). */
function parseAcceptanceCriteria(body: string, latestDirection: string | null): string[] {
  const out: string[] = [];
  const lines = body.split("\n");
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^#{1,6}\s*(acceptance|done when|acceptance criteria|requirements)\b/i.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s/.test(line)) inSection = false; // next header ends the section
    const checklist = line.match(/^[-*]\s*(\[[ xX]\]\s*)?(.+)$/);
    if (inSection && checklist) out.push(checklist[2]!.trim());
    else if (checklist?.[1]) out.push(checklist[2]!.trim()); // a markdown checkbox anywhere
  }
  if (latestDirection?.trim()) out.push(latestDirection.trim());
  return [...new Set(out)].slice(0, 20);
}

/** Repo-relative-looking paths mentioned in the ticket body. */
function filesMentioned(body: string): string[] {
  const matches = body.match(/\b[\w./-]+\.[a-zA-Z]{1,8}\b/g) ?? [];
  return matches.filter((m) => m.includes("/") || /\.(ts|tsx|js|jsx|py|md|json|css|sql)$/.test(m));
}

export function buildManifest(args: {
  project: Project;
  ticket: Ticket;
  attempt: number;
  branch: { commits: string[]; files: string[] };
  trail: TicketEvent[];
  latestJournal?: AttemptJournalEntry;
  artifactsDir: string;
}): TaskManifest {
  const { project, ticket, attempt, branch, trail, latestJournal, artifactsDir } = args;
  const latestDirection = [...trail].reverse().find((e) => e.kind === "triage")?.message ?? null;

  const relatedFiles = [...new Set([...branch.files, ...filesMentioned(ticket.body)])].slice(
    0,
    MAX_RELATED_FILES,
  );

  let issueEvidence: string | null = null;
  if (latestJournal && latestJournal.verifyPassed === false) {
    const parts: string[] = [];
    if (latestJournal.diagnosis) parts.push(`Diagnosis: ${latestJournal.diagnosis}`);
    if (latestJournal.verifyOutput) parts.push(`Verify output:\n${latestJournal.verifyOutput}`);
    issueEvidence = parts.join("\n\n") || null;
  }

  const manifest: TaskManifest = {
    ticketId: ticket.id,
    ticketTitle: ticket.title,
    attempt,
    acceptanceCriteria: parseAcceptanceCriteria(ticket.body, latestDirection),
    setupCommand: project.setupCommand,
    verifyCommands: project.verifyCommands ?? [],
    relatedFiles,
    issueEvidence,
    recentCommits: branch.commits.slice(0, 20),
    trail: trail.slice(-20).map((e) => ({ actor: e.actor, kind: e.kind, message: e.message })),
  };

  try {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(join(artifactsDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    writeFileSync(join(artifactsDir, "manifest.md"), renderManifestMarkdown(manifest), "utf8");
  } catch {
    /* artifact write is best-effort; the in-memory manifest still feeds the prompt */
  }
  return manifest;
}

/** Render the manifest as the "Task manifest" section of the worker prompt. */
export function renderManifestMarkdown(m: TaskManifest): string {
  const lines: string[] = [];
  lines.push(`# Task manifest — attempt ${m.attempt}`);
  lines.push("");
  lines.push("## Acceptance criteria (what 'done' means)");
  if (m.acceptanceCriteria.length) for (const a of m.acceptanceCriteria) lines.push(`- ${a}`);
  else lines.push("- (none stated explicitly — satisfy the ticket below)");
  lines.push("");
  lines.push("## How to verify your work (run these before finishing)");
  if (m.setupCommand) lines.push(`- setup: \`${m.setupCommand}\` (already run once for this branch)`);
  if (m.verifyCommands.length) for (const c of m.verifyCommands) lines.push(`- verify: \`${c}\``);
  else lines.push("- (no verify commands configured — still build/test if you can)");
  lines.push("");
  lines.push(
    "These EXACT verify commands gate your work: an evaluator will run them and a reviewer will judge the diff before any PR is opened. Make them pass.",
  );
  if (m.issueEvidence) {
    lines.push("");
    lines.push("## What failed on the previous attempt (fix this)");
    lines.push(m.issueEvidence);
  }
  if (m.relatedFiles.length) {
    lines.push("");
    lines.push("## Related files");
    for (const f of m.relatedFiles) lines.push(`- ${f}`);
  }
  if (m.recentCommits.length) {
    lines.push("");
    lines.push("## Commits already on this branch");
    for (const c of m.recentCommits) lines.push(`- ${c}`);
  }
  return lines.join("\n");
}
