# Chorus Architecture

Hub-and-spoke. One daemon (the hub) coordinates stateless agents (the spokes).
Everything is TypeScript on Node 22; SQLite is the single source of truth.

## Data flow (one ticket)

```
ticket (open)
   │  orchestrator.tick() picks highest-priority open ticket
   ▼
git worktree add  →  chorus/ticket-<id>  (cut from origin/<base>, fetched first)
   │
   ▼
backend.startRun()  →  codex / claude / gemini CLI
   │   (isolated worktree, permission bypass, group-killable, idle/wall timeouts)
   ▼
result + git inspection  →  done-detection, then orchestrator triage
   │   work ready (committed + coherent)?
   ├─ no  → assign again / close / needs_human (notify)
   └─ yes → git push origin chorus/ticket-<id>  +  gh pr create --base <base>
              │
              ▼
        ticket → pr_open (PR link stored + shown), iMessage "PR opened"
              │
              ▼
        you merge the PR on GitHub  →  poller (gh pr view) flips ticket → merged
```

`main` is never pushed to or merged by Chorus. Each ticket becomes a GitHub PR;
merging it is always a manual human action on GitHub. Chorus polls open PRs and
marks the ticket `merged` once GitHub reports the PR merged.

## Key design decisions

- **Structured result files are authoritative.** Backend event streams are
  telemetry (progress, token usage, logs); the schema-validated result file is
  what drives ticket state. Streams are parsed defensively (partial lines,
  non-JSON noise) and fully persisted as raw logs.
- **"Done" is not a boolean.** Process exit means "the agent stopped," not
  "the work is correct." Opening a PR requires clean exit **and** a structured
  success **and** a real new commit. Rich terminal states (`done-no-changes`,
  `partial`, `done-unverified`, …) drive the next action.
- **One git mutex.** Parallel agents edit files in separate worktrees safely,
  but every shared-ref operation (worktree add, fetch, push) serializes
  through a single mutex in `git-service` — nothing else shells out to git.
- **Group-kill.** AI CLIs spawn child processes; the runner spawns detached and
  signals the whole process group, so stop/pause/timeout never orphan work.
- **PIDs are dead on boot.** SQLite is durable; processes are not. Restart
  reconciliation re-derives each interrupted task's fate from git state and
  re-opens or flags work — it never reattaches a PID. Tickets already in
  `pr_open` survive a restart and the PR poller resumes watching them.
- **Quota is account-global.** A quota-exhausted exit pauses *all* dispatch,
  preserves worktrees, and a single backoff scheduler resumes by re-running in
  the same worktree. The exhaustion signal is a config-tunable regex classifier.
- **Backend abstraction.** The orchestrator depends only on the `AIBackend`
  interface via a registry. Codex, Claude Code, and Gemini CLI adapters live in
  `packages/backends`.

## Deferred (Milestone 2+)

Email notifications, precise quota-reset parsing, native CLI session resume,
automatic conflict resolution, a visual role editor, dollar-cost projection,
multi-repo, crash-loop quarantine.
