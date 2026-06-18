# chorus

Chorus is a self-hosted, 24/7 AI engineering team. A single orchestrator coordinates role-based agents—dev, QA, designer, and more—each with defined guardrails. Powered by subscription CLI tools like Codex, it tracks costs, manages git branches, logs every change, and merges work for human review before it reaches main.

> **Status:** Milestone 1 — an end-to-end vertical slice is implemented:
> New Project → clone via `gh` → read `docs/SPEC.md` → generate tickets →
> Codex agent works on a per-ticket git branch → orchestrator detects done →
> `--no-ff` merge into the integration branch → changelog + iMessage →
> live web dashboard. `main` is never touched autonomously.

## Quick start

```bash
npm install && npm run build
npm --workspace @chorus/dashboard run build
node packages/daemon/dist/main.js   # → http://127.0.0.1:7878
```

See **[docs/RUNNING.md](docs/RUNNING.md)** for prerequisites, config, the 24/7
launchd service, Tailscale, and the safety model, and
**[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the package layout.

## Architecture (hub-and-spoke)

A single TypeScript daemon (Node 22) is the hub. It owns task dispatch, agent
execution, git, merging, the changelog, quota gating, and notifications. Agents
are stateless workers: each runs a subscription CLI (`codex exec`) in an
isolated git worktree on its own branch.

```
packages/
  core/          shared types, Zod schemas, the AIBackend/Notifier/ControlApi contracts
  proc/          process spawning: detached groups, group-kill, line-reading, raw logs
  db/            SQLite (better-sqlite3), migrations, repositories — the source of truth
  git-service/   the only module that touches git; one mutex serializes shared-ref ops
  backends/      AIBackend registry + Codex adapter (Claude/Gemini deferred)
  notifier/      iMessage (osascript) + composite/null notifiers
  spec-ingest/   SPEC.md → tickets via a structured Codex run
  orchestrator/  the state machine: dispatch → done-detect → merge → changelog; quota; reconcile
  web/           Fastify REST + WebSocket; reads the DB, issues commands to the daemon
  daemon/        composition root: wires everything, boot reconciliation, lifecycle
apps/
  dashboard/     React + Vite control panel
```

## Tests

```bash
npm test
```
