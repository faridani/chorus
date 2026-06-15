# Running Chorus

Chorus is a monorepo: a TypeScript daemon (`packages/*`) plus a React/Vite
dashboard (`apps/dashboard`). One long-lived daemon process owns everything;
the dashboard is served by that daemon in production.

## Prerequisites

- **Node 22+** and npm 10+.
- **`gh` CLI**, authenticated (`gh auth status`). All git/GitHub actions run as
  this account.
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
| `port` / `host` | dashboard/API bind (default `127.0.0.1:7878`) |
| `integrationBranch` | branch agents merge into (default `chorus/integration`) |
| `maxConcurrentAgents` | parallel agents (default 2) |
| `quota.exhaustionPatterns` | regexes that mean "quota exhausted" — tune as you learn Codex's wording |
| `notifications.imessageTo` | phone/Apple ID to iMessage on merges |

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

Open `http://127.0.0.1:7878`. Click **New project**, paste a GitHub repo URL.
Chorus clones it, finds `docs/SPEC.md` (or prompts you for one), generates
tickets, and the orchestrator starts dispatching them to Codex agents.

## 24/7 service (macOS launchd)

Edit `deploy/com.chorus.daemon.plist` paths, then:

```bash
cp deploy/com.chorus.daemon.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.chorus.daemon.plist
```

`KeepAlive` restarts the daemon on crash; on boot it reconciles interrupted
work (every stored PID is treated as dead, task state re-derived from git).

## Remote access (Tailscale)

Keep `host` on loopback and expose via Tailscale instead of opening a port:

```bash
tailscale serve --bg 7878
```

## Safety model

- Agents run `codex exec --dangerously-bypass-approvals-and-sandbox` inside an
  **isolated git worktree** on a per-ticket branch — never on `main`.
- A local **pre-push hook** blocks pushes to `main`/`master`/base.
- Completed work merges into the **integration branch** only. Promotion to
  `main` requires the explicit **Approve** action in the dashboard (a local
  `--no-ff` merge; pushing remains your call).

## Tests

```bash
npm test    # unit + integration (git worktree/merge, codex parsing, reconcile)
```
