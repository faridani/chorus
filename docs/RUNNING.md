# Running Chorus

Chorus is a monorepo: a TypeScript daemon (`packages/*`) plus a React/Vite
dashboard (`apps/dashboard`). One long-lived daemon process owns everything;
the dashboard is served by that daemon in production.

## Prerequisites

- **Node 22+** and npm 10+.
- **`gh` CLI**, authenticated (`gh auth login` / `gh auth status`). All
  git/GitHub actions — cloning, pushing ticket branches, and opening PRs — run as
  this account, so it needs push + PR access to each repo.
- **`codex` CLI**, logged in (`codex login`). This is the agent backend.
- macOS if you want **iMessage** notifications (uses `osascript`).
- (Optional) **Tailscale** for remote access without public exposure.

## Install & build

```bash
npm install
npm run build                       # compiles all packages
npm --workspace @chorus/dashboard run build   # builds the dashboard SPA
```

## Configure

Copy the example and edit it (or rely on defaults):

```bash
cp chorus.config.example.json chorus.config.json
export CHORUS_CONFIG=$PWD/chorus.config.json
```

Key fields (all optional; sensible defaults apply):

| field | meaning |
|---|---|
| `dataDir` | where the SQLite db, clones, worktrees, run logs live (default `~/.chorus`) |
| `port` / `host` | dashboard/API bind (default `0.0.0.0:7878` — reachable from other machines; set `host` to `127.0.0.1` for loopback only) |
| `maxConcurrentAgents` | parallel agents (default 2) |
| `quota.exhaustionPatterns` | regexes that mean "quota exhausted" — tune as you learn Codex's wording |
| `notifications.imessageTo` | phone/Apple ID to iMessage when a PR is opened/merged |

Env overrides: `CHORUS_DATA_DIR`, `CHORUS_PORT`, `CHORUS_HOST`,
`CHORUS_DASHBOARD_DIR`.

## Run

```bash
# development (auto-reload, dashboard via Vite dev server with proxy)
npm run dev                                  # daemon on :7878
npm --workspace @chorus/dashboard run dev    # dashboard on :5173

# production (daemon serves the built dashboard)
node packages/daemon/dist/main.js
```

Open `http://127.0.0.1:7878` (or `http://<this-host>:7878` from another machine,
since the default bind is `0.0.0.0`). Click **New project**, paste a GitHub repo URL.
Chorus clones it, finds `docs/SPEC.md` (or prompts you for one), generates
tickets, and the orchestrator starts dispatching them to Codex agents. When a
ticket's work is ready, Chorus pushes its branch and opens a GitHub PR against
the base branch; the PR link appears in the ticket's **PR** column. Merge it on
GitHub and Chorus marks the ticket merged.

## 24/7 service (macOS launchd)

Edit `deploy/com.chorus.daemon.plist` paths, then:

```bash
cp deploy/com.chorus.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chorus.daemon.plist
```

`KeepAlive` restarts the daemon on crash; on boot it reconciles interrupted
work (every stored PID is treated as dead, task state re-derived from git).

## Remote access (Tailscale)

If you'd rather not expose the port on your LAN, set `host` to `127.0.0.1` and
expose via Tailscale instead:

```bash
tailscale serve --bg 7878
```

## Safety model

- Agents run `codex exec --dangerously-bypass-approvals-and-sandbox` inside an
  **isolated git worktree** on a per-ticket branch (cut from `origin/<base>`) —
  never on `main`. Agents commit locally and **never push**.
- A local **pre-push hook** blocks pushes to `main`/`master`/base. Chorus (not
  the agent) pushes only the ticket branch, which the hook allows.
- Completed work is pushed as a per-ticket branch and opened as a **GitHub PR**
  against the base branch. Merging the PR is always a manual human action on
  GitHub — Chorus never merges to `main` itself.

## Tests

```bash
npm test    # unit + integration (git worktree/push, codex parsing, reconcile)
```
