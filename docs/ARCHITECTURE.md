# Chorus Architecture

Hub-and-spoke. One daemon (the hub) coordinates stateless agents (the spokes).
Everything is TypeScript on Node 22; SQLite is the single source of truth.

## Data flow (one ticket)

```
ticket (open)
   │  orchestrator.tick() picks highest-priority open ticket
   ▼
git worktree add  →  chorus/ticket-<id>-a<attempt>  (cut from integration tip)
   │
   ▼
backend.startRun()  →  codex exec --json --output-schema -o result.json
   │   (isolated worktree, full sandbox, group-killable, idle/wall timeouts)
   ▼
result + git inspection  →  done-detection
   │   clean exit + valid output (status=success) + real commit + clean tree?
   ├─ no  → done-no-changes / partial / done-unverified / failed → needs_review (notify)
   └─ yes → merge --no-ff into chorus/integration
              │
              ├─ conflict → mark conflicted, leave branch, notify human
              └─ merged   → changelog (DB + CHANGELOG.md commit), iMessage, cleanup worktree
```

`main` is only ever touched by the explicit **Approve** action, which does a
local `--no-ff` merge of the integration branch into the base branch.

## Key design decisions

- **Output file, not the event stream, is authoritative.** `codex exec`'s
  `--json` JSONL is telemetry (progress, token usage); the `-o` file validated
  against a Zod schema is the result. The stream is parsed defensively
  (partial lines, non-JSON noise) and fully persisted as a raw log.
- **"Done" is not a boolean.** Process exit means "the agent stopped," not
  "the work is correct." Merge requires clean exit **and** a structured success
  **and** a real new commit **and** a clean worktree. Rich terminal states
  (`done-no-changes`, `partial`, `done-unverified`, `conflicted`, …) drive the
  next action.
- **One git mutex.** Parallel agents edit files in separate worktrees safely,
  but every shared-ref operation (worktree add, fetch, merge) serializes
  through a single mutex in `git-service` — nothing else shells out to git.
- **Group-kill.** Codex spawns child processes; the runner spawns detached and
  signals the whole process group, so stop/pause/timeout never orphan work.
- **PIDs are dead on boot.** SQLite is durable; processes are not. Restart
  reconciliation re-derives each interrupted task's fate from git state, aborts
  any dangling merge, and re-opens or flags work — it never reattaches a PID.
- **Quota is account-global.** A quota-exhausted exit pauses *all* dispatch,
  preserves worktrees, and a single backoff scheduler resumes by re-running in
  the same worktree. The exhaustion signal is a config-tunable regex classifier.
- **Backend abstraction.** The orchestrator depends only on the `AIBackend`
  interface via a registry; adding Claude/Gemini is a new adapter package with
  no orchestrator change.

## Deferred (Milestone 2+)

Claude/Gemini adapters, email notifications, precise quota-reset parsing and
native CLI session resume, automatic conflict resolution, a visual role editor,
dollar-cost projection, multi-repo, crash-loop quarantine.
