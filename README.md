# chorus

Chorus is a self-hosted, 24/7 AI engineering team. A single orchestrator coordinates role-based agents—dev, QA, designer, and more—each with defined guardrails. Powered by subscription CLI tools like Codex, it tracks costs, manages git branches, logs every change, and opens a GitHub pull request for each ticket so a human can review and merge it.

> **Status:** Milestone 1 — an end-to-end vertical slice is implemented:
> New Project → clone via `gh` → read `docs/SPEC.md` → generate tickets →
> Codex agent works on a per-ticket git branch (cut from `origin/main`) →
> orchestrator detects done → pushes the branch and opens a **GitHub PR** against
> `main` → the ticket shows the PR link → you merge the PR manually; Chorus polls
> GitHub and marks the ticket merged. `main` is never pushed to autonomously.

## Quick start

```bash
npm install && npm run build
npm --workspace @chorus/dashboard run build
node packages/daemon/dist/main.js   # → http://0.0.0.0:7878
```

The dashboard binds to `0.0.0.0` by default, so it's reachable from other
machines on your network/Tailscale at `http://<this-host>:7878`. To restrict it
to loopback, set `CHORUS_HOST=127.0.0.1`.

See **[docs/RUNNING.md](docs/RUNNING.md)** for prerequisites, config, the 24/7
launchd service, Tailscale, and the safety model, and
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the package layout.

## Architecture (hub-and-spoke)

A single TypeScript daemon (Node 22) is the hub. It owns task dispatch, agent
execution, git, pushing branches + opening PRs, the changelog, quota gating, and
notifications. Agents are stateless workers: each runs a subscription CLI
(`codex exec`) in an isolated git worktree on its per-ticket branch.

```
packages/
  core/          shared types, Zod schemas, the AIBackend/Notifier/ControlApi contracts
  proc/          process spawning: detached groups, group-kill, line-reading, raw logs
  db/            SQLite (better-sqlite3), migrations, repositories — the source of truth
  git-service/   the only module that touches git; one mutex serializes shared-ref ops
  backends/      AIBackend registry + Codex adapter (Claude/Gemini deferred)
  notifier/      iMessage (osascript) + composite/null notifiers
  spec-ingest/   SPEC.md → tickets via a structured Codex run
  orchestrator/  the state machine: dispatch → done-detect → push + open PR → poll for merge; quota; reconcile
  web/           Fastify REST + WebSocket; reads the DB, issues commands to the daemon
  daemon/        composition root: wires everything, boot reconciliation, lifecycle
apps/
  dashboard/     React + Vite control panel
```

## Tests

```bash
npm test
```

---

## Agent-generated Python build (`src/`)

> This tree (`src/chorus/`, `tests/`) is an **independent Python implementation
> produced by Chorus's own agents** building from the spec ("Chorus builds
> Chorus"). It is kept alongside the TypeScript implementation above for
> reference/review, not as a replacement.

### Persistence

Chorus uses a local SQLite database for durable orchestrator and dashboard state. The default path is `.chorus/chorus.db`, and it can be overridden with `CHORUS_DB_PATH` or by passing a path to `chorus.open_store(path)`.

The initial migration creates tables for projects, roles, guardrails, agents, tickets, tasks, runs, quota samples, branch state, merges, notifications, and changelog entries. All mutable records include timestamps and status/state fields so the service can resume after a restart.

Built-in tickets can be managed through the public ticket helpers (`create_ticket`, `edit_ticket`, `assign_ticket`, `reprioritize_ticket`, `transition_ticket`, and `close_ticket`). Tickets use the lifecycle statuses `backlog`, `ready`, `in_progress`, `review`, `merged`, `blocked`, and `done`, and resume snapshots from `build_project_resume_state` include tickets with linked agent-run IDs.

Run the Python persistence tests with:

```sh
python3 -m unittest discover -s tests
```
